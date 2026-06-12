package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multimira-ai/multimira/server/internal/analytics"
	"github.com/multimira-ai/multimira/server/internal/auth"
	"github.com/multimira-ai/multimira/server/internal/logger"
	obsmetrics "github.com/multimira-ai/multimira/server/internal/metrics"
	db "github.com/multimira-ai/multimira/server/pkg/db/generated"
)

// Feishu (Lark) SSO login. This is the ONLY login method in the self-hosted
// internal build (email OTP / Google are removed once SSO is live). It mirrors
// the Google OAuth flow in auth.go: exchange an authorization code for a user
// access token, read the user's enterprise email, then findOrCreateUser +
// issueJWT. Signup gating (ALLOWED_EMAIL_DOMAINS=bytedance.com) is enforced by
// findOrCreateUser → checkSignupAllowed, so the company tenant cannot flood in
// past the domain allowlist.
//
// Config (env):
//   - LARK_SSO_APP_ID / LARK_SSO_APP_SECRET: the self-built Feishu app creds.
//   - LARK_SSO_BASE_URL: open-platform host (default https://open.feishu.cn).
//   - LARK_SSO_REDIRECT_URI: fallback redirect URI when the client omits one.
//   - LARK_SSO_SCOPE: optional space-separated scopes (e.g. to request email).
//
// The Feishu app MUST be granted the email permission (contact:user.email or
// enterprise_email) or user_info returns no email and login fails closed.

func larkSSOBaseURL() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv("LARK_SSO_BASE_URL")), "/"); v != "" {
		return v
	}
	return "https://open.feishu.cn"
}

func larkSSOConfigured() (appID, appSecret string, ok bool) {
	appID = strings.TrimSpace(os.Getenv("LARK_SSO_APP_ID"))
	appSecret = strings.TrimSpace(os.Getenv("LARK_SSO_APP_SECRET"))
	return appID, appSecret, appID != "" && appSecret != ""
}

// LarkLoginURL returns the Feishu authorization URL the frontend should
// redirect the browser to. Keeping app_id server-side avoids leaking it into
// the bundle and lets the deployment swap apps without a frontend rebuild.
func (h *Handler) LarkLoginURL(w http.ResponseWriter, r *http.Request) {
	appID, _, ok := larkSSOConfigured()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "Feishu login is not configured")
		return
	}

	redirectURI := strings.TrimSpace(r.URL.Query().Get("redirect_uri"))
	if redirectURI == "" {
		redirectURI = strings.TrimSpace(os.Getenv("LARK_SSO_REDIRECT_URI"))
	}
	if redirectURI == "" {
		writeError(w, http.StatusBadRequest, "redirect_uri is required")
		return
	}

	q := url.Values{}
	q.Set("app_id", appID)
	q.Set("redirect_uri", redirectURI)
	if state := strings.TrimSpace(r.URL.Query().Get("state")); state != "" {
		q.Set("state", state)
	}
	if scope := strings.TrimSpace(os.Getenv("LARK_SSO_SCOPE")); scope != "" {
		q.Set("scope", scope)
	}

	authorizeURL := larkSSOBaseURL() + "/open-apis/authen/v1/authorize?" + q.Encode()
	writeJSON(w, http.StatusOK, map[string]string{"url": authorizeURL})
}

type larkTokenResponse struct {
	Code        int    `json:"code"`
	Msg         string `json:"msg"`
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
}

type larkUserInfoResponse struct {
	Code int `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		Name            string `json:"name"`
		EnName          string `json:"en_name"`
		Email           string `json:"email"`
		EnterpriseEmail string `json:"enterprise_email"`
		OpenID          string `json:"open_id"`
		UnionID         string `json:"union_id"`
		AvatarURL       string `json:"avatar_url"`
	} `json:"data"`
}

// LarkLoginCallback completes the OAuth code exchange and logs the user in.
// POST body: { "code": "...", "redirect_uri": "..." }.
func (h *Handler) LarkLoginCallback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code        string `json:"code"`
		RedirectURI string `json:"redirect_uri"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if strings.TrimSpace(req.Code) == "" {
		writeError(w, http.StatusBadRequest, "code is required")
		return
	}

	appID, appSecret, ok := larkSSOConfigured()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "Feishu login is not configured")
		return
	}

	redirectURI := strings.TrimSpace(req.RedirectURI)
	if redirectURI == "" {
		redirectURI = strings.TrimSpace(os.Getenv("LARK_SSO_REDIRECT_URI"))
	}

	base := larkSSOBaseURL()

	// 1. Exchange the authorization code for a user access token (authen v2).
	tokenBody, _ := json.Marshal(map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     appID,
		"client_secret": appSecret,
		"code":          req.Code,
		"redirect_uri":  redirectURI,
	})
	tokenReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, base+"/open-apis/authen/v2/oauth/token", bytes.NewReader(tokenBody))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	tokenReq.Header.Set("Content-Type", "application/json; charset=utf-8")

	tokenResp, err := http.DefaultClient.Do(tokenReq)
	if err != nil {
		slog.Error("lark oauth token exchange failed", "error", err)
		writeError(w, http.StatusBadGateway, "failed to exchange code with Feishu")
		return
	}
	defer tokenResp.Body.Close()
	tokenRaw, _ := io.ReadAll(tokenResp.Body)

	var tok larkTokenResponse
	if err := json.Unmarshal(tokenRaw, &tok); err != nil {
		writeError(w, http.StatusBadGateway, "failed to parse Feishu token response")
		return
	}
	if tok.AccessToken == "" {
		slog.Error("lark oauth token exchange returned no token", "status", tokenResp.StatusCode, "code", tok.Code, "msg", tok.Msg)
		writeError(w, http.StatusBadRequest, "failed to exchange code with Feishu")
		return
	}

	// 2. Fetch the user's profile (authen v1 user_info).
	infoReq, err := http.NewRequestWithContext(r.Context(), http.MethodGet, base+"/open-apis/authen/v1/user_info", nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	infoReq.Header.Set("Authorization", "Bearer "+tok.AccessToken)

	infoResp, err := http.DefaultClient.Do(infoReq)
	if err != nil {
		slog.Error("lark user_info fetch failed", "error", err)
		writeError(w, http.StatusBadGateway, "failed to fetch user info from Feishu")
		return
	}
	defer infoResp.Body.Close()

	var info larkUserInfoResponse
	if err := json.NewDecoder(infoResp.Body).Decode(&info); err != nil {
		writeError(w, http.StatusBadGateway, "failed to parse Feishu user info")
		return
	}

	email := strings.ToLower(strings.TrimSpace(firstNonEmpty(info.Data.EnterpriseEmail, info.Data.Email)))
	if email == "" {
		writeError(w, http.StatusBadRequest, "Feishu account has no email (grant the app the user email scope)")
		return
	}

	user, isNew, err := h.findOrCreateUser(r.Context(), email)
	if err != nil {
		var signupErr SignupError
		if errors.As(err, &signupErr) {
			writeError(w, http.StatusForbidden, signupErr.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	if isNew {
		evt := analytics.Signup(uuidToString(user.ID), user.Email, signupSourceFromRequest(r))
		evt.Properties["auth_method"] = "lark"
		obsmetrics.RecordEvent(h.Analytics, h.Metrics, evt)
	}

	// Populate name/avatar from the Feishu profile on first login.
	displayName := firstNonEmpty(info.Data.Name, info.Data.EnName)
	needsUpdate := false
	newName := user.Name
	newAvatar := user.AvatarUrl
	if displayName != "" && user.Name == strings.Split(email, "@")[0] {
		newName = displayName
		needsUpdate = true
	}
	if info.Data.AvatarURL != "" && !user.AvatarUrl.Valid {
		newAvatar = pgtype.Text{String: info.Data.AvatarURL, Valid: true}
		needsUpdate = true
	}
	if needsUpdate {
		if updated, err := h.Queries.UpdateUser(r.Context(), db.UpdateUserParams{
			ID:        user.ID,
			Name:      newName,
			AvatarUrl: newAvatar,
		}); err == nil {
			user = updated
		}
	}

	// TODO(self-host): opportunistically upsert the user↔open_id binding here
	// once the user is a workspace member, so DM notifications work without a
	// separate manual bind. The binding has a composite FK to member(), so it
	// must run after invitation auto-join, not at first login. For v1, DM push
	// relies on the existing chatops bind flow. open_id captured here:
	// info.Data.OpenID / info.Data.UnionID.

	tokenString, err := h.issueJWT(user)
	if err != nil {
		slog.Warn("lark login failed", append(logger.RequestAttrs(r), "error", err, "email", email)...)
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	if err := auth.SetAuthCookies(w, tokenString); err != nil {
		slog.Warn("failed to set auth cookies", "error", err)
	}
	if h.CFSigner != nil {
		for _, cookie := range h.CFSigner.SignedCookies(time.Now().Add(72 * time.Hour)) {
			http.SetCookie(w, cookie)
		}
	}

	slog.Info("user logged in via lark", append(logger.RequestAttrs(r), "user_id", uuidToString(user.ID), "email", user.Email)...)
	writeJSON(w, http.StatusOK, LoginResponse{
		Token: tokenString,
		User:  userToResponse(user),
	})
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
