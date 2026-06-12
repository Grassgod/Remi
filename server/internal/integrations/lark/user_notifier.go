package lark

import (
	"context"
	"errors"
	"log/slog"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multimira-ai/multimira/server/pkg/db/generated"
)

// DMSender is the narrow capability UserNotifier needs from the Lark client:
// post a markdown card to a user's p2p chat. The production *httpAPIClient
// satisfies it; the stub does not — so DM push no-ops when Lark is
// unconfigured (the wiring's type assertion simply fails and leaves the
// notifier unset).
type DMSender interface {
	SendMarkdownDM(ctx context.Context, creds InstallationCredentials, openID, markdown, summary string) (string, error)
}

// NotifierQueries is the DB surface UserNotifier needs (satisfied by *db.Queries).
type NotifierQueries interface {
	GetLarkInstallation(ctx context.Context, id pgtype.UUID) (db.LarkInstallation, error)
}

// PgxRowQuerier is the minimal pgx surface for the single-row binding lookup
// (satisfied by *pgxpool.Pool).
type PgxRowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// UserNotifier delivers proactive Multimira notifications to a member's Feishu
// DM. It resolves the member's open_id from lark_user_binding, decrypts the
// installation's bot credentials, and posts a markdown card. Every step fails
// soft: an unbound user, a missing installation, or a Lark error is logged and
// swallowed — DM notifications are best-effort and must never break the caller.
type UserNotifier struct {
	pool    PgxRowQuerier
	queries NotifierQueries
	decrypt func(db.LarkInstallation) (string, error)
	sender  DMSender
	log     *slog.Logger
}

func NewUserNotifier(
	pool PgxRowQuerier,
	queries NotifierQueries,
	decrypt func(db.LarkInstallation) (string, error),
	sender DMSender,
	log *slog.Logger,
) *UserNotifier {
	if log == nil {
		log = slog.Default()
	}
	return &UserNotifier{pool: pool, queries: queries, decrypt: decrypt, sender: sender, log: log}
}

// NotifyUser posts a markdown DM to the member identified by userID. The
// signature matches service.TaskService.DMNotifier so it can be wired in
// directly. It never returns an error — failures are logged and dropped.
func (n *UserNotifier) NotifyUser(ctx context.Context, userID pgtype.UUID, title, body string) {
	if n == nil || n.sender == nil || n.pool == nil {
		return
	}

	// Most-recent binding for this user. Raw query keeps us off sqlc (which is
	// network-gated in this environment); lark.sql's GetLarkUserBindingByUserID
	// is the eventual typed replacement once `make sqlc` runs.
	var openID string
	var installationID pgtype.UUID
	err := n.pool.QueryRow(ctx,
		`SELECT lark_open_id, installation_id FROM lark_user_binding
		 WHERE multimira_user_id = $1 ORDER BY bound_at DESC LIMIT 1`, userID,
	).Scan(&openID, &installationID)
	if err != nil {
		// No row = the user hasn't bound Feishu; that is the common, expected
		// case and must stay quiet. Anything else is a real fault.
		if !errors.Is(err, pgx.ErrNoRows) {
			n.log.Debug("lark notify: binding lookup failed", "error", err)
		}
		return
	}

	inst, err := n.queries.GetLarkInstallation(ctx, installationID)
	if err != nil {
		n.log.Debug("lark notify: installation load failed", "error", err)
		return
	}
	secret, err := n.decrypt(inst)
	if err != nil {
		n.log.Warn("lark notify: decrypt app secret failed", "error", err)
		return
	}

	creds := InstallationCredentials{
		AppID:     inst.AppID,
		AppSecret: secret,
		Region:    RegionOrDefault(inst.Region),
	}
	markdown := body
	if title != "" {
		markdown = "**" + title + "**\n" + body
	}
	if _, err := n.sender.SendMarkdownDM(ctx, creds, openID, markdown, title); err != nil {
		n.log.Warn("lark notify: send DM failed", "error", err)
	}
}
