package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/readpref"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"

	"github.com/skyhook-io/radar/internal/auth"
	"github.com/skyhook-io/radar/internal/k8s"
)

const defaultMongoPort = 27017

type MongoInstance struct {
	ID             string                 `json:"id"`
	Context        string                 `json:"context"`
	Name           string                 `json:"name"`
	Namespace      string                 `json:"namespace"`
	ServiceName    string                 `json:"serviceName"`
	ServiceType    string                 `json:"serviceType"`
	ServiceCluster string                 `json:"serviceClusterIp,omitempty"`
	Port           int                    `json:"port"`
	Architecture   string                 `json:"architecture,omitempty"`
	Version        string                 `json:"version,omitempty"`
	HelmRelease    string                 `json:"helmRelease,omitempty"`
	HelmChart      string                 `json:"helmChart,omitempty"`
	Replicas       int32                  `json:"replicas,omitempty"`
	ReadyReplicas  int32                  `json:"readyReplicas,omitempty"`
	Pods           []MongoPod             `json:"pods"`
	Credentials    []MongoCredentialRef   `json:"credentials"`
	Backups        []MongoBackupWorkload  `json:"backups"`
	Labels         map[string]string      `json:"labels,omitempty"`
	Warnings       []string               `json:"warnings,omitempty"`
	Raw            map[string]interface{} `json:"raw,omitempty"`
}

type MongoPod struct {
	Name      string `json:"name"`
	Ready     string `json:"ready"`
	Phase     string `json:"phase"`
	Role      string `json:"role,omitempty"`
	PodIP     string `json:"podIp,omitempty"`
	NodeName  string `json:"nodeName,omitempty"`
	Restarts  int32  `json:"restarts"`
	StartedAt string `json:"startedAt,omitempty"`
}

type MongoCredentialRef struct {
	Namespace     string `json:"namespace"`
	Name          string `json:"name"`
	UsernameKey   string `json:"usernameKey,omitempty"`
	PasswordKey   string `json:"passwordKey,omitempty"`
	AuthSourceKey string `json:"authSourceKey,omitempty"`
	UsernameHint  string `json:"usernameHint,omitempty"`
	AuthSource    string `json:"authSource,omitempty"`
	Scope         string `json:"scope"`
}

type MongoBackupWorkload struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Schedule  string `json:"schedule,omitempty"`
	Suspended bool   `json:"suspended,omitempty"`
	LastRun   string `json:"lastRun,omitempty"`
	Status    string `json:"status,omitempty"`
}

type mongoConnectRequest struct {
	InstanceID   string              `json:"instanceId"`
	Namespace    string              `json:"namespace"`
	ServiceName  string              `json:"serviceName"`
	Port         int                 `json:"port"`
	Username     string              `json:"username,omitempty"`
	Password     string              `json:"password,omitempty"`
	AuthSource   string              `json:"authSource,omitempty"`
	Credential   *MongoCredentialRef `json:"credential,omitempty"`
	DatabaseName string              `json:"databaseName,omitempty"`
}

type MongoSession struct {
	ID          string    `json:"id"`
	InstanceID  string    `json:"instanceId"`
	Context     string    `json:"context"`
	Namespace   string    `json:"namespace"`
	ServiceName string    `json:"serviceName"`
	LocalPort   int       `json:"localPort"`
	CreatedAt   time.Time `json:"createdAt"`

	client  *mongo.Client
	pfID    string
	cancel  context.CancelFunc
	expires time.Time
}

type MongoDatabase struct {
	Name string `json:"name"`
}

type MongoCollection struct {
	Name string `json:"name"`
}

type MongoDocumentsResponse struct {
	Documents []any `json:"documents"`
	Limit     int   `json:"limit"`
}

type mongoUpdateDocumentRequest struct {
	ID       json.RawMessage `json:"id"`
	Document json.RawMessage `json:"document"`
}

var mongoSessionStore = struct {
	sync.RWMutex
	sessions map[string]*MongoSession
}{sessions: map[string]*MongoSession{}}

func (s *Server) handleMongoInstances(w http.ResponseWriter, r *http.Request) {
	client := s.getClientForRequest(r)
	if client == nil {
		s.writeError(w, http.StatusServiceUnavailable, "cluster client not available")
		return
	}

	ctxName := ""
	if status := k8s.GetConnectionStatus(); status.Context != "" {
		ctxName = status.Context
	}

	services, err := client.CoreV1().Services("").List(r.Context(), metav1.ListOptions{})
	if err != nil {
		log.Printf("[mongodb] Failed to list services: %v", err)
		s.writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	statefulSets, _ := client.AppsV1().StatefulSets("").List(r.Context(), metav1.ListOptions{})
	pods, _ := client.CoreV1().Pods("").List(r.Context(), metav1.ListOptions{})
	secrets, _ := client.CoreV1().Secrets("").List(r.Context(), metav1.ListOptions{})
	cronJobs, _ := client.BatchV1().CronJobs("").List(r.Context(), metav1.ListOptions{})
	jobs, _ := client.BatchV1().Jobs("").List(r.Context(), metav1.ListOptions{})

	credentialRefs := discoverMongoCredentialRefs(secrets)
	instances := make([]MongoInstance, 0)
	for _, svc := range services.Items {
		port, ok := mongoServicePort(&svc)
		if !ok || !looksLikeMongoService(&svc) {
			continue
		}
		if isMongoAuxiliaryService(svc.Name, svc.Labels) {
			continue
		}
		if isMongoServiceAlias(&svc, services) {
			continue
		}

		instance := MongoInstance{
			ID:             mongoInstanceID(ctxName, svc.Namespace, svc.Name, port),
			Context:        ctxName,
			Name:           mongoInstanceName(&svc),
			Namespace:      svc.Namespace,
			ServiceName:    svc.Name,
			ServiceType:    string(svc.Spec.Type),
			ServiceCluster: svc.Spec.ClusterIP,
			Port:           port,
			Architecture:   svc.Labels["mongodb-architecture"],
			Version:        svc.Labels["app.kubernetes.io/version"],
			HelmRelease:    svc.Labels["app.kubernetes.io/instance"],
			HelmChart:      svc.Labels["helm.sh/chart"],
			Labels:         svc.Labels,
		}

		sts := matchMongoStatefulSet(&svc, statefulSets)
		if sts != nil {
			instance.Replicas = replicasOrZero(sts.Spec.Replicas)
			instance.ReadyReplicas = sts.Status.ReadyReplicas
			if instance.Architecture == "" {
				instance.Architecture = sts.Labels["mongodb-architecture"]
			}
			if instance.Version == "" {
				instance.Version = sts.Labels["app.kubernetes.io/version"]
			}
			if instance.HelmRelease == "" {
				instance.HelmRelease = sts.Labels["app.kubernetes.io/instance"]
			}
			if instance.HelmChart == "" {
				instance.HelmChart = sts.Labels["helm.sh/chart"]
			}
		}

		instance.Pods = matchMongoPods(&svc, pods)
		instance.Credentials = credentialRefsForInstance(instance, credentialRefs)
		instance.Backups = matchMongoBackups(instance, cronJobs, jobs)
		if len(instance.Credentials) == 0 {
			instance.Warnings = append(instance.Warnings, "No Mongo credential secret candidates found")
		}
		if len(instance.Pods) == 0 {
			instance.Warnings = append(instance.Warnings, "No running pods matched the service selector")
		}
		instances = append(instances, instance)
	}

	sort.Slice(instances, func(i, j int) bool {
		if instances[i].Namespace == instances[j].Namespace {
			return instances[i].Name < instances[j].Name
		}
		return instances[i].Namespace < instances[j].Namespace
	})
	s.writeJSON(w, instances)
}

func (s *Server) handleMongoConnect(w http.ResponseWriter, r *http.Request) {
	var req mongoConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Namespace == "" || req.ServiceName == "" {
		s.writeError(w, http.StatusBadRequest, "namespace and serviceName are required")
		return
	}
	if req.Port == 0 {
		req.Port = defaultMongoPort
	}

	auth.AuditLog(r, req.Namespace, req.ServiceName)
	client := s.getClientForRequest(r)
	config := s.getConfigForRequest(r)
	if client == nil || config == nil {
		s.writeError(w, http.StatusServiceUnavailable, "cluster client not available")
		return
	}

	username, password, authSource, err := s.resolveMongoCredentials(r.Context(), client, req)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if authSource == "" {
		authSource = "admin"
	}

	podName, podPort, _, err := findPodForService(r.Context(), client, req.Namespace, req.ServiceName, req.Port)
	if err != nil {
		s.writeError(w, http.StatusNotFound, fmt.Sprintf("No pod found for Mongo service %s: %v", req.ServiceName, err))
		return
	}
	localPort, err := findFreePort()
	if err != nil {
		s.writeError(w, http.StatusInternalServerError, "failed to find free local port")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	pfSession := &PortForwardSession{
		ID:            "mongo-pf-" + uuid.NewString(),
		Namespace:     req.Namespace,
		PodName:       podName,
		ServiceName:   req.ServiceName,
		PodPort:       podPort,
		LocalPort:     localPort,
		ListenAddress: "127.0.0.1",
		StartedAt:     time.Now(),
		Status:        "starting",
		cancel:        cancel,
		stopCh:        make(chan struct{}),
		restConfig:    config,
		k8sClient:     client,
	}
	pfManager.mu.Lock()
	pfManager.sessions[pfSession.ID] = pfSession
	pfManager.mu.Unlock()

	errCh := make(chan error, 1)
	go func() {
		errCh <- runPortForward(ctx, pfSession)
	}()

	if err := waitForMongoPortForward(pfSession.ID, errCh); err != nil {
		cancel()
		cancelMongoPortForward(pfSession.ID)
		s.writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to start Mongo port-forward: %v", err))
		return
	}

	connectCtx, connectCancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer connectCancel()
	mongoClient, err := mongo.Connect(options.Client().ApplyURI(mongoURI(localPort, username, password, authSource)))
	if err == nil {
		err = mongoClient.Ping(connectCtx, readpref.Primary())
	}
	if err == nil {
		_, err = mongoClient.ListDatabaseNames(connectCtx, bson.D{})
	}
	if err != nil {
		if mongoClient != nil {
			_ = mongoClient.Disconnect(context.Background())
		}
		cancelMongoPortForward(pfSession.ID)
		s.writeError(w, http.StatusBadRequest, fmt.Sprintf("failed to connect to MongoDB: %v", err))
		return
	}

	session := &MongoSession{
		ID:          uuid.NewString(),
		InstanceID:  req.InstanceID,
		Context:     k8s.GetConnectionStatus().Context,
		Namespace:   req.Namespace,
		ServiceName: req.ServiceName,
		LocalPort:   localPort,
		CreatedAt:   time.Now(),
		client:      mongoClient,
		pfID:        pfSession.ID,
		cancel:      cancel,
		expires:     time.Now().Add(4 * time.Hour),
	}
	mongoSessionStore.Lock()
	mongoSessionStore.sessions[session.ID] = session
	mongoSessionStore.Unlock()

	s.writeJSON(w, session)
}

func (s *Server) handleMongoSessions(w http.ResponseWriter, r *http.Request) {
	mongoSessionStore.RLock()
	defer mongoSessionStore.RUnlock()

	sessions := make([]*MongoSession, 0, len(mongoSessionStore.sessions))
	for _, session := range mongoSessionStore.sessions {
		sessions = append(sessions, session)
	}
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].CreatedAt.After(sessions[j].CreatedAt)
	})
	s.writeJSON(w, sessions)
}

func (s *Server) handleMongoDisconnect(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	session, ok := popMongoSession(sessionID)
	if !ok {
		s.writeError(w, http.StatusNotFound, "Mongo session not found")
		return
	}
	disconnectMongoSession(session)
	s.writeJSON(w, map[string]string{"status": "disconnected"})
}

func (s *Server) handleMongoDatabases(w http.ResponseWriter, r *http.Request) {
	session, ok := getMongoSession(chi.URLParam(r, "sessionID"))
	if !ok {
		s.writeError(w, http.StatusNotFound, "Mongo session not found")
		return
	}
	names, err := session.client.ListDatabaseNames(r.Context(), bson.D{})
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	dbs := make([]MongoDatabase, 0, len(names))
	for _, name := range names {
		dbs = append(dbs, MongoDatabase{Name: name})
	}
	sort.Slice(dbs, func(i, j int) bool { return dbs[i].Name < dbs[j].Name })
	s.writeJSON(w, dbs)
}

func (s *Server) handleMongoCollections(w http.ResponseWriter, r *http.Request) {
	session, ok := getMongoSession(chi.URLParam(r, "sessionID"))
	if !ok {
		s.writeError(w, http.StatusNotFound, "Mongo session not found")
		return
	}
	dbName, err := url.PathUnescape(chi.URLParam(r, "database"))
	if err != nil || dbName == "" {
		s.writeError(w, http.StatusBadRequest, "invalid database")
		return
	}
	names, err := session.client.Database(dbName).ListCollectionNames(r.Context(), bson.D{})
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	collections := make([]MongoCollection, 0, len(names))
	for _, name := range names {
		collections = append(collections, MongoCollection{Name: name})
	}
	sort.Slice(collections, func(i, j int) bool { return collections[i].Name < collections[j].Name })
	s.writeJSON(w, collections)
}

func (s *Server) handleMongoDocuments(w http.ResponseWriter, r *http.Request) {
	session, ok := getMongoSession(chi.URLParam(r, "sessionID"))
	if !ok {
		s.writeError(w, http.StatusNotFound, "Mongo session not found")
		return
	}
	dbName, collName, err := mongoPathParams(r)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	limit := boundedMongoLimit(r.URL.Query().Get("limit"))
	filter, err := parseMongoFilter(r.URL.Query().Get("filter"))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cursor, err := session.client.Database(dbName).Collection(collName).Find(r.Context(), filter, options.Find().SetLimit(int64(limit)))
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cursor.Close(r.Context())

	var docs []bson.M
	if err := cursor.All(r.Context(), &docs); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rendered := make([]any, 0, len(docs))
	for _, doc := range docs {
		rendered = append(rendered, bsonToExtendedJSON(doc))
	}
	s.writeJSON(w, MongoDocumentsResponse{Documents: rendered, Limit: limit})
}

func (s *Server) handleMongoUpdateDocument(w http.ResponseWriter, r *http.Request) {
	session, ok := getMongoSession(chi.URLParam(r, "sessionID"))
	if !ok {
		s.writeError(w, http.StatusNotFound, "Mongo session not found")
		return
	}
	dbName, collName, err := mongoPathParams(r)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var req mongoUpdateDocumentRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if len(req.Document) == 0 {
		s.writeError(w, http.StatusBadRequest, "document is required")
		return
	}

	var document bson.M
	if err := bson.UnmarshalExtJSON(req.Document, false, &document); err != nil {
		s.writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid document JSON: %v", err))
		return
	}
	if _, hasID := document["_id"]; !hasID {
		s.writeError(w, http.StatusBadRequest, "document must include _id")
		return
	}

	filterID := document["_id"]
	if len(req.ID) > 0 {
		filterID, err = parseMongoID(req.ID)
		if err != nil {
			s.writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if !mongoIDsEqual(filterID, document["_id"]) {
		s.writeError(w, http.StatusBadRequest, "changing _id is not supported")
		return
	}

	result, err := session.client.Database(dbName).Collection(collName).ReplaceOne(r.Context(), bson.M{"_id": filterID}, document)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if result.MatchedCount == 0 {
		s.writeError(w, http.StatusNotFound, "document not found")
		return
	}
	var saved bson.M
	if err := session.client.Database(dbName).Collection(collName).FindOne(r.Context(), bson.M{"_id": filterID}).Decode(&saved); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	s.writeJSON(w, bsonToExtendedJSON(saved))
}

func (s *Server) handleMongoIndexes(w http.ResponseWriter, r *http.Request) {
	session, ok := getMongoSession(chi.URLParam(r, "sessionID"))
	if !ok {
		s.writeError(w, http.StatusNotFound, "Mongo session not found")
		return
	}
	dbName, collName, err := mongoPathParams(r)
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	cursor, err := session.client.Database(dbName).Collection(collName).Indexes().List(r.Context())
	if err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cursor.Close(r.Context())
	var indexes []bson.M
	if err := cursor.All(r.Context(), &indexes); err != nil {
		s.writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	rendered := make([]any, 0, len(indexes))
	for _, idx := range indexes {
		rendered = append(rendered, bsonToExtendedJSON(idx))
	}
	s.writeJSON(w, rendered)
}

func mongoServicePort(svc *corev1.Service) (int, bool) {
	for _, p := range svc.Spec.Ports {
		if int(p.Port) == defaultMongoPort || strings.Contains(strings.ToLower(p.Name), "mongo") {
			return int(p.Port), true
		}
	}
	return 0, false
}

func looksLikeMongoService(svc *corev1.Service) bool {
	haystack := strings.ToLower(svc.Name + " " + labels.Set(svc.Labels).String())
	return strings.Contains(haystack, "mongo") || strings.Contains(haystack, "documentdb") || strings.Contains(haystack, "percona")
}

func isMongoAuxiliaryService(name string, labels map[string]string) bool {
	haystack := strings.ToLower(name + " " + labels["app.kubernetes.io/component"])
	return strings.Contains(haystack, "metrics") || strings.Contains(haystack, "arbiter")
}

func isMongoServiceAlias(svc *corev1.Service, services *corev1.ServiceList) bool {
	if services == nil || svc.Spec.Type != corev1.ServiceTypeLoadBalancer {
		return false
	}
	instance := svc.Labels["app.kubernetes.io/instance"]
	if instance == "" && len(svc.Spec.Selector) == 0 {
		return false
	}
	for _, other := range services.Items {
		if other.Namespace != svc.Namespace || other.Name == svc.Name || other.Spec.Type == corev1.ServiceTypeLoadBalancer {
			continue
		}
		sameInstance := instance != "" && other.Labels["app.kubernetes.io/instance"] == instance
		sameSelector := mongoSelectorsOverlap(svc.Spec.Selector, other.Spec.Selector)
		if sameInstance || sameSelector {
			if _, ok := mongoServicePort(&other); ok && looksLikeMongoService(&other) && !isMongoAuxiliaryService(other.Name, other.Labels) {
				return true
			}
		}
	}
	return false
}

func mongoSelectorsOverlap(a, b map[string]string) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	aSet := labels.Set(a)
	bSet := labels.Set(b)
	return labels.SelectorFromSet(aSet).Matches(bSet) || labels.SelectorFromSet(bSet).Matches(aSet)
}

func mongoInstanceName(svc *corev1.Service) string {
	if v := svc.Labels["app.kubernetes.io/instance"]; v != "" {
		return v
	}
	return svc.Name
}

func mongoInstanceID(ctxName, namespace, service string, port int) string {
	return fmt.Sprintf("%s/%s/%s/%d", ctxName, namespace, service, port)
}

func matchMongoStatefulSet(svc *corev1.Service, list *appsv1.StatefulSetList) *appsv1.StatefulSet {
	if list == nil {
		return nil
	}
	instance := svc.Labels["app.kubernetes.io/instance"]
	for i := range list.Items {
		sts := &list.Items[i]
		if sts.Namespace != svc.Namespace {
			continue
		}
		if instance != "" && sts.Labels["app.kubernetes.io/instance"] == instance && strings.Contains(strings.ToLower(sts.Name), "mongo") {
			return sts
		}
		if sts.Spec.ServiceName == svc.Name {
			return sts
		}
	}
	return nil
}

func matchMongoPods(svc *corev1.Service, list *corev1.PodList) []MongoPod {
	if list == nil || len(svc.Spec.Selector) == 0 {
		return nil
	}
	selector := labels.SelectorFromSet(svc.Spec.Selector)
	pods := make([]MongoPod, 0)
	for _, pod := range list.Items {
		if pod.Namespace != svc.Namespace || !selector.Matches(labels.Set(pod.Labels)) {
			continue
		}
		restarts := int32(0)
		ready := 0
		total := len(pod.Status.ContainerStatuses)
		for _, cs := range pod.Status.ContainerStatuses {
			restarts += cs.RestartCount
			if cs.Ready {
				ready++
			}
		}
		started := ""
		if pod.Status.StartTime != nil {
			started = pod.Status.StartTime.Time.Format(time.RFC3339)
		}
		pods = append(pods, MongoPod{
			Name:      pod.Name,
			Ready:     fmt.Sprintf("%d/%d", ready, total),
			Phase:     string(pod.Status.Phase),
			PodIP:     pod.Status.PodIP,
			NodeName:  pod.Spec.NodeName,
			Restarts:  restarts,
			StartedAt: started,
		})
	}
	sort.Slice(pods, func(i, j int) bool { return pods[i].Name < pods[j].Name })
	return pods
}

func discoverMongoCredentialRefs(secrets *corev1.SecretList) []MongoCredentialRef {
	if secrets == nil {
		return nil
	}
	refs := make([]MongoCredentialRef, 0)
	for _, secret := range secrets.Items {
		keys := secret.Data
		ref := MongoCredentialRef{Namespace: secret.Namespace, Name: secret.Name, Scope: "candidate"}
		name := strings.ToLower(secret.Name)
		if hasKey(keys, "MONGODB_ROOT_PASSWORD") {
			ref.PasswordKey = "MONGODB_ROOT_PASSWORD"
			ref.UsernameKey = firstExistingKey(keys, "MONGODB_ROOT_USER", "MONGODB_USERNAME", "username")
			ref.AuthSourceKey = firstExistingKey(keys, "MONGODB_AUTH_SOURCE", "authSource")
			ref.UsernameHint = "root"
			ref.AuthSource = "admin"
		} else if hasKey(keys, "mongodb-root-password") {
			ref.PasswordKey = "mongodb-root-password"
			ref.UsernameHint = "root"
			ref.AuthSource = "admin"
		} else if hasKey(keys, "mongodb-passwords") {
			ref.PasswordKey = "mongodb-passwords"
			ref.UsernameHint = "user"
			ref.AuthSource = "admin"
		} else if !strings.Contains(name, "mongo") {
			continue
		}
		if strings.Contains(name, "helm.release") {
			continue
		}
		refs = append(refs, ref)
	}
	sort.Slice(refs, func(i, j int) bool {
		if refs[i].Namespace == refs[j].Namespace {
			return refs[i].Name < refs[j].Name
		}
		return refs[i].Namespace < refs[j].Namespace
	})
	return refs
}

func credentialRefsForInstance(instance MongoInstance, refs []MongoCredentialRef) []MongoCredentialRef {
	result := make([]MongoCredentialRef, 0)
	for _, ref := range refs {
		copyRef := ref
		if ref.Namespace == instance.Namespace {
			copyRef.Scope = "same-namespace"
			result = append(result, copyRef)
			continue
		}
		if strings.Contains(strings.ToLower(ref.Name), strings.ToLower(instance.Name)) || strings.Contains(strings.ToLower(ref.Name), "mongo") {
			copyRef.Scope = "cross-namespace"
			result = append(result, copyRef)
		}
	}
	return result
}

func matchMongoBackups(instance MongoInstance, cronJobs *batchv1.CronJobList, jobs *batchv1.JobList) []MongoBackupWorkload {
	backups := make([]MongoBackupWorkload, 0)
	matches := func(ns, name string) bool {
		if ns != instance.Namespace {
			return false
		}
		lower := strings.ToLower(name)
		return strings.Contains(lower, "mongo") || strings.Contains(lower, "dump") || strings.Contains(lower, "restore")
	}
	if cronJobs != nil {
		for _, cj := range cronJobs.Items {
			if !matches(cj.Namespace, cj.Name) {
				continue
			}
			backups = append(backups, MongoBackupWorkload{
				Kind:      "CronJob",
				Name:      cj.Name,
				Schedule:  cj.Spec.Schedule,
				Suspended: cj.Spec.Suspend != nil && *cj.Spec.Suspend,
			})
		}
	}
	if jobs != nil {
		for _, job := range jobs.Items {
			if !matches(job.Namespace, job.Name) {
				continue
			}
			status := "running"
			if job.Status.Succeeded > 0 {
				status = "complete"
			} else if job.Status.Failed > 0 {
				status = "failed"
			}
			backups = append(backups, MongoBackupWorkload{Kind: "Job", Name: job.Name, Status: status})
		}
	}
	return backups
}

func (s *Server) resolveMongoCredentials(ctx context.Context, client kubernetes.Interface, req mongoConnectRequest) (string, string, string, error) {
	username, password, authSource := req.Username, req.Password, req.AuthSource
	if req.Credential == nil {
		return username, password, authSource, nil
	}
	if client == nil {
		return "", "", "", fmt.Errorf("cluster client not available")
	}
	secret, err := client.CoreV1().Secrets(req.Credential.Namespace).Get(ctx, req.Credential.Name, metav1.GetOptions{})
	if err != nil {
		return "", "", "", fmt.Errorf("failed to read credential secret %s/%s: %w", req.Credential.Namespace, req.Credential.Name, err)
	}
	if req.Credential.UsernameKey != "" {
		username = string(secret.Data[req.Credential.UsernameKey])
	}
	if username == "" {
		username = req.Credential.UsernameHint
	}
	if req.Credential.PasswordKey != "" {
		password = string(secret.Data[req.Credential.PasswordKey])
	}
	if req.Credential.AuthSourceKey != "" {
		authSource = string(secret.Data[req.Credential.AuthSourceKey])
	}
	if authSource == "" {
		authSource = req.Credential.AuthSource
	}
	if username != "" && password == "" {
		return "", "", "", fmt.Errorf("selected credential does not contain a password key")
	}
	return username, password, authSource, nil
}

func mongoURI(localPort int, username, password, authSource string) string {
	host := fmt.Sprintf("127.0.0.1:%d", localPort)
	if username == "" {
		return fmt.Sprintf("mongodb://%s/?directConnection=true", host)
	}
	return fmt.Sprintf("mongodb://%s:%s@%s/?authSource=%s&directConnection=true",
		url.QueryEscape(username),
		url.QueryEscape(password),
		host,
		url.QueryEscape(authSource),
	)
}

func getMongoSession(id string) (*MongoSession, bool) {
	mongoSessionStore.RLock()
	defer mongoSessionStore.RUnlock()
	session, ok := mongoSessionStore.sessions[id]
	return session, ok
}

func popMongoSession(id string) (*MongoSession, bool) {
	mongoSessionStore.Lock()
	defer mongoSessionStore.Unlock()
	session, ok := mongoSessionStore.sessions[id]
	if ok {
		delete(mongoSessionStore.sessions, id)
	}
	return session, ok
}

func disconnectMongoSession(session *MongoSession) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = session.client.Disconnect(ctx)
	cancelMongoPortForward(session.pfID)
	if session.cancel != nil {
		session.cancel()
	}
}

func cancelMongoPortForward(id string) {
	pfManager.mu.Lock()
	session, ok := pfManager.sessions[id]
	if ok {
		if session.cancel != nil {
			session.cancel()
		}
		session.Status = "stopped"
		delete(pfManager.sessions, id)
	}
	pfManager.mu.Unlock()
}

func waitForMongoPortForward(id string, errCh <-chan error) error {
	deadline := time.After(5 * time.Second)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-errCh:
			if err == nil {
				return fmt.Errorf("port-forward stopped before becoming ready")
			}
			return err
		case <-tick.C:
			pfManager.mu.RLock()
			session, ok := pfManager.sessions[id]
			status := ""
			errMsg := ""
			if ok && session != nil {
				status = session.Status
				errMsg = session.Error
			}
			pfManager.mu.RUnlock()
			if status == "running" {
				return nil
			}
			if status == "error" {
				if errMsg == "" {
					errMsg = "unknown port-forward error"
				}
				return fmt.Errorf("%s", errMsg)
			}
		case <-deadline:
			return fmt.Errorf("timed out waiting for port-forward")
		}
	}
}

func mongoPathParams(r *http.Request) (string, string, error) {
	dbName, err := url.PathUnescape(chi.URLParam(r, "database"))
	if err != nil || dbName == "" {
		return "", "", fmt.Errorf("invalid database")
	}
	collName, err := url.PathUnescape(chi.URLParam(r, "collection"))
	if err != nil || collName == "" {
		return "", "", fmt.Errorf("invalid collection")
	}
	return dbName, collName, nil
}

func boundedMongoLimit(raw string) int {
	limit := 50
	if raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	if limit < 1 {
		return 1
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func parseMongoFilter(raw string) (bson.M, error) {
	if strings.TrimSpace(raw) == "" {
		return bson.M{}, nil
	}
	var filter bson.M
	if err := bson.UnmarshalExtJSON([]byte(raw), false, &filter); err != nil {
		return nil, fmt.Errorf("invalid Mongo filter JSON: %w", err)
	}
	return filter, nil
}

func parseMongoID(raw json.RawMessage) (any, error) {
	var wrapper bson.M
	if err := bson.UnmarshalExtJSON([]byte(fmt.Sprintf(`{"_id":%s}`, string(raw))), false, &wrapper); err != nil {
		return nil, fmt.Errorf("invalid document id: %w", err)
	}
	id, ok := wrapper["_id"]
	if !ok {
		return nil, fmt.Errorf("invalid document id")
	}
	return id, nil
}

func mongoIDsEqual(a, b any) bool {
	aBytes, aErr := bson.MarshalExtJSON(bson.M{"_id": a}, false, false)
	bBytes, bErr := bson.MarshalExtJSON(bson.M{"_id": b}, false, false)
	return aErr == nil && bErr == nil && string(aBytes) == string(bBytes)
}

func bsonToExtendedJSON(value any) any {
	raw, err := bson.MarshalExtJSON(value, false, false)
	if err != nil {
		return value
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return string(raw)
	}
	return decoded
}

func replicasOrZero(v *int32) int32 {
	if v == nil {
		return 0
	}
	return *v
}

func hasKey(data map[string][]byte, key string) bool {
	_, ok := data[key]
	return ok
}

func firstExistingKey(data map[string][]byte, keys ...string) string {
	for _, key := range keys {
		if hasKey(data, key) {
			return key
		}
	}
	return ""
}
