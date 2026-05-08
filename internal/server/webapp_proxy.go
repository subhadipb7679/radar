package server

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/skyhook-io/radar/internal/settings"
)

func (s *Server) handleWebAppProxy(w http.ResponseWriter, r *http.Request) {
	appID := chi.URLParam(r, "appID")
	app, ok := findCustomWebApp(appID)
	if !ok {
		s.writeError(w, http.StatusNotFound, "web app not found")
		return
	}

	target, err := url.Parse(app.URL)
	if err != nil || target.Scheme == "" || target.Host == "" {
		s.writeError(w, http.StatusBadRequest, "invalid web app URL")
		return
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		s.writeError(w, http.StatusBadRequest, "only http and https web apps are supported")
		return
	}

	prefix := "/webapp-proxy/" + url.PathEscape(appID)
	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			proxyPath := strings.TrimPrefix(req.URL.Path, prefix)
			if proxyPath == "" {
				proxyPath = "/"
			}
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.URL.Path = joinURLPath(target.Path, proxyPath)
			req.URL.RawPath = ""
			req.Host = target.Host
			req.Header.Set("X-Forwarded-Host", r.Host)
			req.Header.Set("X-Forwarded-Proto", requestProto(r))
			req.Header.Set("X-Forwarded-Prefix", prefix)
			// Let Go transparently decode text responses so ModifyResponse can rewrite them.
			req.Header.Del("Accept-Encoding")
		},
		ModifyResponse: func(resp *http.Response) error {
			stripEmbeddingHeaders(resp.Header)
			rewriteRedirect(resp, target, prefix)
			rewriteCookies(resp, prefix)
			return rewriteProxyBody(resp, target, prefix)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("[webapps] proxy failed for %s: %v", app.Name, err)
			s.writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to load %s: %v", app.Name, err))
		},
	}
	proxy.ServeHTTP(w, r)
}

func findCustomWebApp(id string) (settings.CustomWebApp, bool) {
	for _, app := range settings.Load().WebApps {
		if app.ID == id {
			return app, true
		}
	}
	return settings.CustomWebApp{}, false
}

func stripEmbeddingHeaders(header http.Header) {
	header.Del("X-Frame-Options")
	header.Del("Frame-Options")
	header.Del("Content-Security-Policy")
	header.Del("Content-Security-Policy-Report-Only")
}

func rewriteRedirect(resp *http.Response, target *url.URL, prefix string) {
	location := resp.Header.Get("Location")
	if location == "" {
		return
	}
	rewritten := rewriteURLReference(location, target, prefix)
	resp.Header.Set("Location", rewritten)
}

func rewriteCookies(resp *http.Response, prefix string) {
	values := resp.Header.Values("Set-Cookie")
	if len(values) == 0 {
		return
	}
	resp.Header.Del("Set-Cookie")
	for _, value := range values {
		parts := strings.Split(value, ";")
		out := parts[:0]
		pathSet := false
		for _, part := range parts {
			trimmed := strings.TrimSpace(part)
			lower := strings.ToLower(trimmed)
			switch {
			case strings.HasPrefix(lower, "domain="):
				continue
			case strings.HasPrefix(lower, "path="):
				out = append(out, "Path="+prefix+"/")
				pathSet = true
			default:
				out = append(out, trimmed)
			}
		}
		if !pathSet {
			out = append(out, "Path="+prefix+"/")
		}
		resp.Header.Add("Set-Cookie", strings.Join(out, "; "))
	}
}

func rewriteProxyBody(resp *http.Response, target *url.URL, prefix string) error {
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if !isRewritableContent(contentType) || resp.Body == nil {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	body = rewriteBodyReferences(body, target, prefix)
	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.ContentLength = int64(len(body))
	resp.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	resp.Header.Del("Content-Encoding")
	return nil
}

func isRewritableContent(contentType string) bool {
	return strings.Contains(contentType, "text/html") ||
		strings.Contains(contentType, "text/css") ||
		strings.Contains(contentType, "javascript") ||
		strings.Contains(contentType, "application/json")
}

func rewriteBodyReferences(body []byte, target *url.URL, prefix string) []byte {
	text := string(body)
	targetRoot := target.Scheme + "://" + target.Host
	targetBase := strings.TrimRight(targetRoot+target.EscapedPath(), "/")
	replacements := []string{
		targetRoot + "/", prefix + "/",
		targetBase + "/", prefix + "/",
		`href="/`, `href="` + prefix + `/`,
		`src="/`, `src="` + prefix + `/`,
		`action="/`, `action="` + prefix + `/`,
		`content="/`, `content="` + prefix + `/`,
		`url(/`, `url(` + prefix + `/`,
		`"/api/`, `"` + prefix + `/api/`,
		`'/api/`, `'` + prefix + `/api/`,
		`"/public/`, `"` + prefix + `/public/`,
		`'/public/`, `'` + prefix + `/public/`,
		`"/login`, `"` + prefix + `/login`,
		`'/login`, `'` + prefix + `/login`,
		`"/logout`, `"` + prefix + `/logout`,
		`'/logout`, `'` + prefix + `/logout`,
	}
	text = strings.NewReplacer(replacements...).Replace(text)
	text = regexp.MustCompile(`"appUrl":"[^"]*"`).ReplaceAllString(text, `"appUrl":"`+prefix+`/"`)
	text = strings.ReplaceAll(text, `"appSubUrl":""`, `"appSubUrl":"`+prefix+`"`)
	return []byte(text)
}

func rewriteURLReference(value string, target *url.URL, prefix string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	if parsed.IsAbs() {
		if parsed.Scheme != target.Scheme || parsed.Host != target.Host {
			return value
		}
		return prefix + ensureLeadingSlash(parsed.EscapedPath()) + rawQuerySuffix(parsed)
	}
	if strings.HasPrefix(value, "/") {
		return prefix + value
	}
	return prefix + "/" + value
}

func joinURLPath(basePath, requestPath string) string {
	basePath = strings.TrimRight(basePath, "/")
	requestPath = ensureLeadingSlash(requestPath)
	if basePath == "" || basePath == "/" {
		return requestPath
	}
	return basePath + requestPath
}

func ensureLeadingSlash(path string) string {
	if path == "" || strings.HasPrefix(path, "/") {
		return path
	}
	return "/" + path
}

func rawQuerySuffix(u *url.URL) string {
	if u.RawQuery == "" {
		return ""
	}
	return "?" + u.RawQuery
}

func requestProto(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}
	return "http"
}
