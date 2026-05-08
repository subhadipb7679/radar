package server

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

type urlStatusResponse struct {
	URL        string `json:"url"`
	OK         bool   `json:"ok"`
	Status     string `json:"status"`
	StatusCode int    `json:"statusCode,omitempty"`
	LatencyMs  int64  `json:"latencyMs,omitempty"`
	Error      string `json:"error,omitempty"`
}

func (s *Server) handleURLStatus(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		s.writeError(w, http.StatusBadRequest, "missing url")
		return
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		s.writeError(w, http.StatusBadRequest, "invalid url")
		return
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		s.writeError(w, http.StatusBadRequest, "only http and https URLs are supported")
		return
	}

	status := probeURLStatus(r.Context(), rawURL)
	s.writeJSON(w, status)
}

func probeURLStatus(ctx context.Context, rawURL string) urlStatusResponse {
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	start := time.Now()
	client := &http.Client{
		Timeout: 6 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}

	resp, err := probeURL(ctx, client, http.MethodHead, rawURL)
	if err == nil && resp.StatusCode == http.StatusMethodNotAllowed {
		_ = resp.Body.Close()
		resp, err = probeURL(ctx, client, http.MethodGet, rawURL)
	}
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return urlStatusResponse{
			URL:       rawURL,
			OK:        false,
			Status:    "Unreachable",
			LatencyMs: latency,
			Error:     err.Error(),
		}
	}
	defer resp.Body.Close()

	return urlStatusResponse{
		URL:        rawURL,
		OK:         resp.StatusCode >= 200 && resp.StatusCode < 400,
		Status:     resp.Status,
		StatusCode: resp.StatusCode,
		LatencyMs:  latency,
	}
}

func probeURL(ctx context.Context, client *http.Client, method string, rawURL string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Radar URL Status Probe")
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s failed: %w", method, rawURL, err)
	}
	return resp, nil
}
