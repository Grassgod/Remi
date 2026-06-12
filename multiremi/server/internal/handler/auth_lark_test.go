package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestLarkLoginCallback drives the full Feishu SSO exchange against a mocked
// open-platform server: authen v2 oauth/token → authen v1 user_info →
// findOrCreateUser → issueJWT. It verifies the handler returns a session token
// for the enterprise email and persists the user.
func TestLarkLoginCallback(t *testing.T) {
	const email = "sso_tester@bytedance.com"

	mux := http.NewServeMux()
	mux.HandleFunc("/open-apis/authen/v2/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":         0,
			"access_token": "u-test-token",
			"token_type":   "Bearer",
		})
	})
	mux.HandleFunc("/open-apis/authen/v1/user_info", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer u-test-token" {
			t.Errorf("user_info Authorization = %q, want %q", got, "Bearer u-test-token")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{
				"name":             "SSO Tester",
				"enterprise_email": email,
				"open_id":          "ou_test",
				"union_id":         "on_test",
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	t.Setenv("LARK_SSO_BASE_URL", srv.URL)
	t.Setenv("LARK_SSO_APP_ID", "cli_test")
	t.Setenv("LARK_SSO_APP_SECRET", "secret_test")
	t.Setenv("JWT_SECRET", "test-jwt-secret-for-sso")

	cleanup := func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM "user" WHERE email = $1`, email)
	}
	cleanup()
	defer cleanup()

	w := httptest.NewRecorder()
	req := newRequest(http.MethodPost, "/auth/lark/callback", map[string]string{
		"code":         "auth-code",
		"redirect_uri": "http://localhost:3000/auth/callback",
	})
	testHandler.LarkLoginCallback(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}

	var resp LoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Token == "" {
		t.Error("expected a non-empty session token")
	}
	if resp.User.Email != email {
		t.Errorf("user email = %q, want %q", resp.User.Email, email)
	}

	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM "user" WHERE email = $1`, email).Scan(&count); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if count != 1 {
		t.Errorf("persisted user rows = %d, want 1", count)
	}
}

// TestLarkLoginCallback_NoEmail fails closed when the Feishu profile carries no
// email (the app lacks the email scope) — we cannot provision an email-keyed
// account without it.
func TestLarkLoginCallback_NoEmail(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/open-apis/authen/v2/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "access_token": "u-x"})
	})
	mux.HandleFunc("/open-apis/authen/v1/user_info", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 0,
			"data": map[string]any{"name": "No Email", "open_id": "ou_x"},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	t.Setenv("LARK_SSO_BASE_URL", srv.URL)
	t.Setenv("LARK_SSO_APP_ID", "cli_test")
	t.Setenv("LARK_SSO_APP_SECRET", "secret_test")

	w := httptest.NewRecorder()
	req := newRequest(http.MethodPost, "/auth/lark/callback", map[string]string{"code": "c"})
	testHandler.LarkLoginCallback(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

// TestLarkLoginURL returns the authorize URL built from configured app id +
// redirect uri.
func TestLarkLoginURL(t *testing.T) {
	t.Setenv("LARK_SSO_BASE_URL", "https://open.feishu.cn")
	t.Setenv("LARK_SSO_APP_ID", "cli_app123")
	t.Setenv("LARK_SSO_APP_SECRET", "secret")

	w := httptest.NewRecorder()
	req := newRequest(http.MethodGet, "/auth/lark/url?redirect_uri=http://localhost:3000/auth/callback&state=login", nil)
	testHandler.LarkLoginURL(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.URL == "" {
		t.Fatal("expected a non-empty authorize url")
	}
	for _, want := range []string{"/open-apis/authen/v1/authorize", "app_id=cli_app123", "state=login"} {
		if !strings.Contains(resp.URL, want) {
			t.Errorf("authorize url %q missing %q", resp.URL, want)
		}
	}
}
