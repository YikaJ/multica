package slack

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/slack-go/slack"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ErrInvalidBotToken / ErrInvalidAppToken are returned by RegisterBYO when a
// pasted token is malformed (wrong prefix, or an app token whose app id cannot
// be parsed). The handler maps them to 400 so the dialog can show a precise hint
// instead of a generic failure.
var (
	ErrInvalidBotToken = errors.New("slack: bot token must start with xoxb-")
	ErrInvalidAppToken = errors.New("slack: app-level token must start with xapp- and embed an app id")
)

// RegisterBYOParams are the inputs for a bring-your-own-app install: the agent
// this bot represents, who is installing, and the two tokens the user pasted
// from their own Slack app.
type RegisterBYOParams struct {
	WorkspaceID pgtype.UUID
	AgentID     pgtype.UUID
	InitiatorID pgtype.UUID
	BotToken    string // xoxb-… — outbound Web API (chat.postMessage)
	AppToken    string // xapp-… — this app's OWN Socket Mode connection (inbound)
}

// RegisterBYO installs a user-supplied ("bring your own") Slack app for an agent.
// The user creates their own Slack app, installs it to their workspace, and
// pastes its bot token (xoxb-) + app-level token (xapp-). Unlike the hosted
// OAuth path there is NO code exchange: we validate the bot token live via
// auth.test (which also yields the team id + bot user id), parse the real Slack
// app id out of the app-level token, encrypt BOTH tokens at rest, and persist a
// per-app installation keyed by that real app id.
//
// Because each BYO app is a distinct Slack app — a distinct bot identity — the
// SAME Slack workspace can host several of them, one per agent (the whole point
// of BYO; the hosted B2 model is capped at one agent per workspace). Real app
// ids ("A…") never collide with the team ids ("T…") the hosted path stores at
// config->>'app_id', so hosted and BYO installations share the unique index
// without a schema change. The dedicated Socket Mode connection that consumes
// the stored app token lives in the connector (separate change); this method
// only persists the installation.
func (s *InstallService) RegisterBYO(ctx context.Context, p RegisterBYOParams) (db.ChannelInstallation, error) {
	botToken := strings.TrimSpace(p.BotToken)
	appToken := strings.TrimSpace(p.AppToken)
	if !strings.HasPrefix(botToken, "xoxb-") {
		return db.ChannelInstallation{}, ErrInvalidBotToken
	}
	appID, err := parseSlackAppID(appToken)
	if err != nil {
		return db.ChannelInstallation{}, err
	}

	// Validate the bot token live and learn the team + bot user id. auth.test
	// authenticates with the bot token and returns the bot's OWN user id, which
	// is the @-mention identity inbound translation strips.
	auth, err := s.authTest(ctx, botToken)
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("slack auth.test: %w", err)
	}
	if auth.TeamID == "" || auth.UserID == "" {
		return db.ChannelInstallation{}, errors.New("slack auth.test: response missing team_id / user_id")
	}

	sealedBot, err := s.box.Seal([]byte(botToken))
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encrypt slack bot token: %w", err)
	}
	sealedApp, err := s.box.Seal([]byte(appToken))
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encrypt slack app token: %w", err)
	}
	cfgJSON, err := json.Marshal(installConfig{
		AppID:             appID,
		TeamID:            auth.TeamID,
		BotUserID:         auth.UserID,
		BotTokenEncrypted: base64.StdEncoding.EncodeToString(sealedBot),
		AppTokenEncrypted: base64.StdEncoding.EncodeToString(sealedApp),
	})
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("encode slack installation config: %w", err)
	}

	// Persist keyed by the REAL app id (not the team id) so several BYO apps in
	// one Slack workspace coexist. No installer auto-bind: a paste carries no
	// authed_user, so the installer binds via the normal token flow on first
	// message. The shared persistInstall provides the atomic cross-workspace
	// guard and agent-move retire.
	return s.persistInstall(ctx, installPersist{
		wsID:        p.WorkspaceID,
		agentID:     p.AgentID,
		installerID: p.InitiatorID,
		appIDKey:    appID,
		configJSON:  cfgJSON,
	})
}

// authTest calls Slack auth.test with the given bot token, honoring the apiURL
// override so tests can point it at an httptest server (mirrors exchangeCode).
// The Slack SDK appends the method name to the endpoint, so the base must end
// in a slash.
func (s *InstallService) authTest(ctx context.Context, botToken string) (*slack.AuthTestResponse, error) {
	httpClient := s.httpClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	opts := []slack.Option{slack.OptionHTTPClient(httpClient)}
	if s.apiURL != "" {
		base := s.apiURL
		if !strings.HasSuffix(base, "/") {
			base += "/"
		}
		opts = append(opts, slack.OptionAPIURL(base))
	}
	return slack.New(botToken, opts...).AuthTestContext(ctx)
}

// parseSlackAppID extracts the real Slack app id from an app-level token. The
// token format is `xapp-1-<APP_ID>-<gen>-<secret>` (e.g. xapp-1-A0BCXGVCS7R-…),
// so the app id is the third dash-segment. It is the per-app storage / routing
// key that lets multiple BYO apps coexist in one Slack workspace.
func parseSlackAppID(appToken string) (string, error) {
	if !strings.HasPrefix(appToken, "xapp-") {
		return "", ErrInvalidAppToken
	}
	parts := strings.SplitN(appToken, "-", 5)
	if len(parts) < 4 || parts[2] == "" || !strings.HasPrefix(parts[2], "A") {
		return "", ErrInvalidAppToken
	}
	return parts[2], nil
}
