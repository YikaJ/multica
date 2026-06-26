package slack

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/slack-go/slack"

	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// This file is the Slack OAuth self-serve install backend (MUL-3666, B2):
// Multica hosts ONE Slack app, and a workspace admin installs it into their
// Slack workspace with an in-product OAuth flow. The OAuth grant yields a
// per-workspace bot token (xoxb-) which — together with team_id — is upserted
// as a channel_type='slack' installation. It is the Slack equivalent of
// lark.RegistrationService / lark.InstallationService, but uses the standard
// OAuth v2 redirect (authorize -> callback -> code exchange) instead of the
// device-code flow, mirroring the GitHub App connect handler.

// stateTTL bounds how long an in-flight OAuth authorization may sit before the
// callback's state is rejected. The state is stateless (sealed, not stored), so
// this is enforced by an embedded expiry rather than a session row.
const stateTTL = 10 * time.Minute

// defaultScopes are the bot scopes requested at install time. They cover the
// inbound events the adapter consumes (app mentions + message history across
// DMs / channels / private channels / group DMs) and outbound posting. Override
// with MULTICA_SLACK_SCOPES if the hosted app is configured differently.
var defaultScopes = []string{
	"app_mentions:read",
	"channels:history",
	"chat:write",
	"groups:history",
	"im:history",
	"mpim:history",
}

var (
	// ErrInstallNotSupported is returned by Begin/Complete when the OAuth
	// client credentials are not configured (so no install can be performed,
	// though listing/revoking existing installs still works).
	ErrInstallNotSupported = errors.New("slack: oauth install not configured (client id/secret/redirect missing)")
	// ErrInvalidState is returned when the callback's state fails to decrypt,
	// is malformed, or has expired.
	ErrInvalidState = errors.New("slack: invalid or expired oauth state")
	// ErrInstallationNotFound surfaces "no row matches in this workspace".
	ErrInstallationNotFound = errors.New("slack installation not found")
	// ErrTeamOwnedByAnotherWorkspace is returned by Complete when the Slack
	// workspace (team) is already connected to a DIFFERENT Multica workspace.
	// Re-pointing it would inherit the other workspace's user / chat-session
	// bindings, so we refuse it. A Slack workspace stays bound to its first
	// Multica workspace: migrating it is an operator/support action (revoking
	// just sets status='revoked' and keeps the row + unique index), not a silent
	// re-OAuth from the other workspace.
	ErrTeamOwnedByAnotherWorkspace = errors.New("slack: this Slack workspace is already connected to a different Multica workspace")
)

// OAuthConfig holds the deployment-level credentials for the hosted Slack app.
type OAuthConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURL  string // {PublicURL}/api/slack/oauth/callback
	Scopes       []string
}

func (c OAuthConfig) supported() bool {
	return c.ClientID != "" && c.ClientSecret != "" && c.RedirectURL != ""
}

// installQueries is the slice of generated queries InstallService needs. WithTx
// returns the same interface bound to a transaction so Complete can run its
// lookup → upsert → binding cleanup → installer-bind atomically.
type installQueries interface {
	WithTx(tx pgx.Tx) installQueries
	GetChannelInstallationByAppID(ctx context.Context, arg db.GetChannelInstallationByAppIDParams) (db.ChannelInstallation, error)
	UpsertChannelInstallationByAppID(ctx context.Context, arg db.UpsertChannelInstallationByAppIDParams) (db.ChannelInstallation, error)
	CreateChannelUserBinding(ctx context.Context, arg db.CreateChannelUserBindingParams) (db.ChannelUserBinding, error)
	DeleteChannelChatSessionBindingsByInstallation(ctx context.Context, arg db.DeleteChannelChatSessionBindingsByInstallationParams) error
	ListChannelInstallationsByWorkspace(ctx context.Context, arg db.ListChannelInstallationsByWorkspaceParams) ([]db.ChannelInstallation, error)
	GetChannelInstallationInWorkspace(ctx context.Context, arg db.GetChannelInstallationInWorkspaceParams) (db.ChannelInstallation, error)
	SetChannelInstallationStatus(ctx context.Context, arg db.SetChannelInstallationStatusParams) error
}

// dbInstallQueries adapts *db.Queries to installQueries — the generated WithTx
// returns *db.Queries, so we wrap it to return the interface (the same adapter
// pattern engine.ChatSession uses).
type dbInstallQueries struct{ *db.Queries }

func (q dbInstallQueries) WithTx(tx pgx.Tx) installQueries {
	return dbInstallQueries{q.Queries.WithTx(tx)}
}

// InstallService owns the OAuth install lifecycle and the at-rest encryption of
// the bot token, so no caller can write a channel_installation with a plaintext
// token. The box MUST be non-nil (we refuse plaintext storage even in dev).
type InstallService struct {
	oauth      OAuthConfig
	box        *secretbox.Box
	q          installQueries
	tx         engine.TxStarter
	httpClient *http.Client
	logger     *slog.Logger
	now        func() time.Time

	// apiURL overrides the Slack API base for the code exchange (tests point
	// it at an httptest server). Empty uses the real Slack API.
	apiURL string
}

// NewInstallService binds the service to queries, a tx starter (*pgxpool.Pool),
// an encryption box, and the hosted app's OAuth credentials. Listing / revoking
// work whenever the box is present; Begin / Complete additionally require the
// OAuth credentials (InstallSupported reports whether they are set).
func NewInstallService(q *db.Queries, tx engine.TxStarter, box *secretbox.Box, oauth OAuthConfig, logger *slog.Logger) (*InstallService, error) {
	if q == nil {
		return nil, errors.New("slack: InstallService requires queries")
	}
	return newInstallService(dbInstallQueries{q}, tx, box, oauth, logger)
}

// newInstallService is the testable core: it takes the installQueries interface
// so tests can inject a fake (with a fake TxStarter) without a real DB.
func newInstallService(q installQueries, tx engine.TxStarter, box *secretbox.Box, oauth OAuthConfig, logger *slog.Logger) (*InstallService, error) {
	if box == nil {
		return nil, errors.New("slack: InstallService requires a non-nil secretbox.Box")
	}
	if q == nil {
		return nil, errors.New("slack: InstallService requires queries")
	}
	if tx == nil {
		return nil, errors.New("slack: InstallService requires a tx starter")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if len(oauth.Scopes) == 0 {
		oauth.Scopes = defaultScopes
	}
	return &InstallService{
		oauth:      oauth,
		box:        box,
		q:          q,
		tx:         tx,
		httpClient: http.DefaultClient,
		logger:     logger,
		now:        time.Now,
	}, nil
}

// InstallSupported reports whether the OAuth begin/complete path is wired (the
// hosted app's client credentials are configured).
func (s *InstallService) InstallSupported() bool { return s.oauth.supported() }

// BeginParams identifies who is installing and which agent the bot represents.
type BeginParams struct {
	WorkspaceID pgtype.UUID
	AgentID     pgtype.UUID
	InitiatorID pgtype.UUID
}

// Begin returns the Slack authorize URL the admin's browser is redirected to.
// The workspace/agent/initiator are sealed into the OAuth state so the callback
// can attribute the install without a server-side session.
func (s *InstallService) Begin(p BeginParams) (string, error) {
	if !s.InstallSupported() {
		return "", ErrInstallNotSupported
	}
	state, err := s.signState(installState{
		WorkspaceID: util.UUIDToString(p.WorkspaceID),
		AgentID:     util.UUIDToString(p.AgentID),
		UserID:      util.UUIDToString(p.InitiatorID),
		Exp:         s.now().Add(stateTTL).Unix(),
		Nonce:       randNonce(),
	})
	if err != nil {
		return "", err
	}
	v := url.Values{}
	v.Set("client_id", s.oauth.ClientID)
	v.Set("scope", strings.Join(s.oauth.Scopes, ","))
	v.Set("redirect_uri", s.oauth.RedirectURL)
	v.Set("state", state)
	return "https://slack.com/oauth/v2/authorize?" + v.Encode(), nil
}

// CompletedInstall is the result of a successful OAuth callback.
type CompletedInstall struct {
	WorkspaceID    pgtype.UUID
	AgentID        pgtype.UUID
	InstallationID pgtype.UUID
	TeamID         string
	TeamName       string
}

// Complete handles the OAuth callback: verify the state, exchange the code for a
// bot token via oauth.v2.access, upsert the installation (bot token encrypted at
// rest), and bind the installing user to their Slack id so their first message
// is not dropped as unbound.
func (s *InstallService) Complete(ctx context.Context, code, rawState string) (CompletedInstall, error) {
	if !s.InstallSupported() {
		return CompletedInstall{}, ErrInstallNotSupported
	}
	st, err := s.verifyState(rawState)
	if err != nil {
		return CompletedInstall{}, err
	}
	wsID, err := util.ParseUUID(st.WorkspaceID)
	if err != nil {
		return CompletedInstall{}, ErrInvalidState
	}
	agentID, err := util.ParseUUID(st.AgentID)
	if err != nil {
		return CompletedInstall{}, ErrInvalidState
	}
	userID, err := util.ParseUUID(st.UserID)
	if err != nil {
		return CompletedInstall{}, ErrInvalidState
	}

	resp, err := s.exchangeCode(ctx, code)
	if err != nil {
		return CompletedInstall{}, err
	}
	if resp.AccessToken == "" || resp.Team.ID == "" || resp.BotUserID == "" {
		return CompletedInstall{}, errors.New("slack oauth: incomplete response (token/team/bot_user_id missing)")
	}

	sealed, err := s.box.Seal([]byte(resp.AccessToken))
	if err != nil {
		return CompletedInstall{}, fmt.Errorf("encrypt slack bot token: %w", err)
	}
	cfgJSON, err := json.Marshal(installConfig{
		AppID:             resp.Team.ID,
		TeamID:            resp.Team.ID,
		BotUserID:         resp.BotUserID,
		BotTokenEncrypted: base64.StdEncoding.EncodeToString(sealed),
	})
	if err != nil {
		return CompletedInstall{}, fmt.Errorf("encode slack installation config: %w", err)
	}
	inst, err := s.persistInstall(ctx, installPersist{
		wsID:             wsID,
		agentID:          agentID,
		installerID:      userID,
		appIDKey:         resp.Team.ID,
		configJSON:       cfgJSON,
		installerSlackID: resp.AuthedUser.ID,
	})
	if err != nil {
		return CompletedInstall{}, err
	}
	return CompletedInstall{
		WorkspaceID:    wsID,
		AgentID:        agentID,
		InstallationID: inst.ID,
		TeamID:         resp.Team.ID,
		TeamName:       resp.Team.Name,
	}, nil
}

// installPersist carries the resolved fields persistInstall writes. appIDKey is
// the value stored at config->>'app_id' — the team id for a hosted OAuth install,
// the real Slack app id for a BYO install — and MUST equal the app_id inside
// configJSON; it is the lookup / ON CONFLICT key. installerSlackID is the
// installer's Slack user id to auto-bind, or "" to skip (a BYO paste carries no
// authed_user, so the installer binds via the normal token flow on first message).
type installPersist struct {
	wsID             pgtype.UUID
	agentID          pgtype.UUID
	installerID      pgtype.UUID
	appIDKey         string
	configJSON       []byte
	installerSlackID string
}

// persistInstall runs the lookup → upsert → stale-binding retire → installer
// bind in ONE transaction, shared by the OAuth Complete and the BYO Register
// paths so the cross-workspace guard and agent-move cleanup can never drift
// between them. The guard is atomic in the upsert's WHERE clause: an app_id
// already owned by a DIFFERENT Multica workspace updates no row and returns
// pgx.ErrNoRows, which maps to ErrTeamOwnedByAnotherWorkspace.
func (s *InstallService) persistInstall(ctx context.Context, p installPersist) (db.ChannelInstallation, error) {
	tx, err := s.tx.Begin(ctx)
	if err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("begin install tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	qtx := s.q.WithTx(tx)

	// Look up any existing installation under this app_id key. Drives ONLY the
	// agent-change cleanup below — NOT the cross-workspace guard (a plain SELECT
	// can't win the concurrent-install race; that guard is in the upsert's WHERE).
	existing, lookupErr := qtx.GetChannelInstallationByAppID(ctx, db.GetChannelInstallationByAppIDParams{
		ChannelType: string(TypeSlack),
		AppID:       p.appIDKey,
	})
	hadExisting := lookupErr == nil
	if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
		return db.ChannelInstallation{}, fmt.Errorf("lookup existing slack installation: %w", lookupErr)
	}

	// app-id-keyed upsert: re-installing the same app — including to represent a
	// different agent in the SAME workspace — updates the existing row rather than
	// colliding with the (channel_type, app_id) index. Its ON CONFLICT update is
	// fenced to the same Multica workspace (the atomic cross-workspace guard).
	inst, err := qtx.UpsertChannelInstallationByAppID(ctx, db.UpsertChannelInstallationByAppIDParams{
		WorkspaceID:     p.wsID,
		AgentID:         p.agentID,
		ChannelType:     string(TypeSlack),
		Config:          p.configJSON,
		InstallerUserID: p.installerID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ChannelInstallation{}, ErrTeamOwnedByAnotherWorkspace
		}
		return db.ChannelInstallation{}, fmt.Errorf("upsert slack installation: %w", err)
	}

	// Agent change within the same workspace: each existing chat_session is
	// permanently tied to the agent it was created under (session.go reuses a
	// session purely by (installation_id, channel_chat_id)), so without this a
	// moved bot's existing DMs / threads would keep routing to the OLD agent
	// (Elon review). Retire the stale chat-session bindings so the next inbound
	// message creates a fresh session under the new agent. User bindings stay
	// valid (same users, same workspace) and are intentionally kept.
	if hadExisting && existing.AgentID != p.agentID {
		if err := qtx.DeleteChannelChatSessionBindingsByInstallation(ctx, db.DeleteChannelChatSessionBindingsByInstallationParams{
			InstallationID: inst.ID,
			ChannelType:    string(TypeSlack),
		}); err != nil {
			return db.ChannelInstallation{}, fmt.Errorf("retire stale chat-session bindings: %w", err)
		}
	}

	// Auto-bind the installer to their Slack user id so their own first DM /
	// mention is not dropped as unbound — mirroring Feishu's installer auto-bind.
	// Skipped when installerSlackID is empty. An id already bound to a DIFFERENT
	// Multica user is a benign skip (the gated upsert returns no rows); a real DB
	// error poisons the tx and must abort the whole install.
	if p.installerSlackID != "" {
		if _, err := qtx.CreateChannelUserBinding(ctx, db.CreateChannelUserBindingParams{
			WorkspaceID:    p.wsID,
			MulticaUserID:  p.installerID,
			InstallationID: inst.ID,
			ChannelType:    string(TypeSlack),
			ChannelUserID:  p.installerSlackID,
			Config:         []byte(`{}`),
		}); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				s.logger.WarnContext(ctx, "slack: installer already bound to a different user; skipping auto-bind",
					"installation_id", util.UUIDToString(inst.ID))
			} else {
				return db.ChannelInstallation{}, fmt.Errorf("bind installer: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return db.ChannelInstallation{}, fmt.Errorf("commit slack install: %w", err)
	}
	return inst, nil
}

// ListByWorkspace returns every Slack installation in the workspace (active and
// revoked), for the management surface.
func (s *InstallService) ListByWorkspace(ctx context.Context, wsID pgtype.UUID) ([]db.ChannelInstallation, error) {
	return s.q.ListChannelInstallationsByWorkspace(ctx, db.ListChannelInstallationsByWorkspaceParams{
		WorkspaceID: wsID,
		ChannelType: string(TypeSlack),
	})
}

// GetInWorkspace is the workspace-scoped lookup so a forged installation id from
// another workspace returns NotFound instead of leaking existence.
func (s *InstallService) GetInWorkspace(ctx context.Context, id, wsID pgtype.UUID) (db.ChannelInstallation, error) {
	inst, err := s.q.GetChannelInstallationInWorkspace(ctx, db.GetChannelInstallationInWorkspaceParams{
		ID:          id,
		WorkspaceID: wsID,
		ChannelType: string(TypeSlack),
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ChannelInstallation{}, ErrInstallationNotFound
		}
		return db.ChannelInstallation{}, err
	}
	return inst, nil
}

// Revoke flips status to 'revoked'. The row is preserved for audit; a re-install
// flips it back to 'active'. The connector simply stops resolving the team
// (GetChannelInstallationByAppID filters to active), and outbound drops too.
func (s *InstallService) Revoke(ctx context.Context, id pgtype.UUID) error {
	return s.q.SetChannelInstallationStatus(ctx, db.SetChannelInstallationStatusParams{
		ID:     id,
		Status: "revoked",
	})
}

// ---- OAuth code exchange ----

func (s *InstallService) exchangeCode(ctx context.Context, code string) (*slack.OAuthV2Response, error) {
	client := s.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	var opts []slack.OAuthOption
	if s.apiURL != "" {
		opts = append(opts, slack.OAuthOptionAPIURL(s.apiURL))
	}
	resp, err := slack.GetOAuthV2ResponseContext(ctx, client, s.oauth.ClientID, s.oauth.ClientSecret, code, s.oauth.RedirectURL, opts...)
	if err != nil {
		return nil, fmt.Errorf("slack oauth exchange: %w", err)
	}
	return resp, nil
}

// ---- sealed OAuth state ----

// installState is the OAuth state, sealed with the deployment secretbox so it is
// both tamper-proof and confidential without a server-side session store.
type installState struct {
	WorkspaceID string `json:"w"`
	AgentID     string `json:"a"`
	UserID      string `json:"u"`
	Exp         int64  `json:"e"`
	Nonce       string `json:"n"`
}

func (s *InstallService) signState(st installState) (string, error) {
	raw, err := json.Marshal(st)
	if err != nil {
		return "", err
	}
	sealed, err := s.box.Seal(raw)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (s *InstallService) verifyState(token string) (installState, error) {
	sealed, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(token))
	if err != nil {
		return installState{}, ErrInvalidState
	}
	raw, err := s.box.Open(sealed)
	if err != nil {
		return installState{}, ErrInvalidState
	}
	var st installState
	if err := json.Unmarshal(raw, &st); err != nil {
		return installState{}, ErrInvalidState
	}
	if s.now().Unix() > st.Exp {
		return installState{}, ErrInvalidState
	}
	return st, nil
}

func randNonce() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is catastrophic and rare; a weak nonce still
		// leaves the state sealed + expiry-bounded, so degrade rather than fail.
		return "n"
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
