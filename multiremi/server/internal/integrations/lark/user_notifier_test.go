package lark

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multimira-ai/multimira/server/pkg/db/generated"
)

type unFakeRow struct {
	openID string
	instID pgtype.UUID
	err    error
}

func (r unFakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if p, ok := dest[0].(*string); ok {
		*p = r.openID
	}
	if p, ok := dest[1].(*pgtype.UUID); ok {
		*p = r.instID
	}
	return nil
}

type unFakePool struct{ row pgx.Row }

func (p unFakePool) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row { return p.row }

type unFakeQueries struct {
	inst db.LarkInstallation
	err  error
}

func (q unFakeQueries) GetLarkInstallation(_ context.Context, _ pgtype.UUID) (db.LarkInstallation, error) {
	return q.inst, q.err
}

type unDMCall struct {
	creds    InstallationCredentials
	openID   string
	markdown string
	summary  string
}

type unFakeSender struct {
	calls []unDMCall
	err   error
}

func (s *unFakeSender) SendMarkdownDM(_ context.Context, creds InstallationCredentials, openID, markdown, summary string) (string, error) {
	s.calls = append(s.calls, unDMCall{creds, openID, markdown, summary})
	return "om_x", s.err
}

func TestUserNotifier_NotifyUser_SendsDM(t *testing.T) {
	instID := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	pool := unFakePool{row: unFakeRow{openID: "ou_target", instID: instID}}
	queries := unFakeQueries{inst: db.LarkInstallation{AppID: "cli_app", Region: "feishu"}}
	decrypt := func(db.LarkInstallation) (string, error) { return "secret", nil }
	sender := &unFakeSender{}

	n := NewUserNotifier(pool, queries, decrypt, sender, slog.Default())
	n.NotifyUser(context.Background(), pgtype.UUID{Bytes: [16]byte{9}, Valid: true}, "MUL-1 Title", "all done")

	if len(sender.calls) != 1 {
		t.Fatalf("expected exactly 1 DM, got %d", len(sender.calls))
	}
	got := sender.calls[0]
	if got.openID != "ou_target" {
		t.Errorf("open_id: got %q want ou_target", got.openID)
	}
	if got.creds.AppID != "cli_app" || got.creds.AppSecret != "secret" {
		t.Errorf("creds not resolved from installation + decrypt: %+v", got.creds)
	}
	if !strings.Contains(got.markdown, "MUL-1 Title") || !strings.Contains(got.markdown, "all done") {
		t.Errorf("markdown should carry title + body; got %q", got.markdown)
	}
}

func TestUserNotifier_NotifyUser_UnboundUserNoOp(t *testing.T) {
	pool := unFakePool{row: unFakeRow{err: pgx.ErrNoRows}}
	sender := &unFakeSender{}
	n := NewUserNotifier(pool, unFakeQueries{}, func(db.LarkInstallation) (string, error) { return "s", nil }, sender, slog.Default())

	n.NotifyUser(context.Background(), pgtype.UUID{Bytes: [16]byte{9}, Valid: true}, "t", "b")

	if len(sender.calls) != 0 {
		t.Errorf("unbound user must not trigger a DM; got %d calls", len(sender.calls))
	}
}

func TestUserNotifier_NotifyUser_DecryptFailureNoOp(t *testing.T) {
	instID := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	pool := unFakePool{row: unFakeRow{openID: "ou_target", instID: instID}}
	queries := unFakeQueries{inst: db.LarkInstallation{AppID: "cli_app"}}
	sender := &unFakeSender{}
	decrypt := func(db.LarkInstallation) (string, error) { return "", context.DeadlineExceeded }

	n := NewUserNotifier(pool, queries, decrypt, sender, slog.Default())
	n.NotifyUser(context.Background(), pgtype.UUID{Bytes: [16]byte{9}, Valid: true}, "t", "b")

	if len(sender.calls) != 0 {
		t.Errorf("decrypt failure must abort the DM; got %d calls", len(sender.calls))
	}
}
