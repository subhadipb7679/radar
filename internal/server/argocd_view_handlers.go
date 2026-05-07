package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/skyhook-io/radar/internal/k8s"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

var (
	argoApplicationGVR = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}
	argoAppSetGVR      = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applicationsets"}
	argoAppProjectGVR  = schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "appprojects"}
)

type argoCDAdminResponse struct {
	ContextName       string            `json:"contextName"`
	CurrentContext    string            `json:"currentContext"`
	Applications      []any             `json:"applications"`
	ApplicationSets   []any             `json:"applicationSets"`
	AppProjects       []any             `json:"appProjects"`
	AvailableContexts []string          `json:"availableContexts"`
	Errors            map[string]string `json:"errors,omitempty"`
}

type argoDestinationPodsResponse struct {
	ContextName string               `json:"contextName"`
	Namespace   string               `json:"namespace"`
	Pods        []argoDestinationPod `json:"pods"`
}

type argoDestinationPod struct {
	Name       string `json:"name"`
	Namespace  string `json:"namespace"`
	Phase      string `json:"phase"`
	Containers int    `json:"containers"`
	Restarts   int32  `json:"restarts"`
}

func (s *Server) handleArgoCDAdminResources(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	adminContext, availableContexts, err := resolveArgoCDAdminContext(r)
	if err != nil {
		s.writeError(w, http.StatusNotFound, err.Error())
		return
	}

	cfg, err := k8s.BuildRESTConfigForContext(adminContext)
	if err != nil {
		s.writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to build admin cluster config: %v", err))
		return
	}
	client, err := dynamic.NewForConfig(cfg)
	if err != nil {
		s.writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to create admin cluster dynamic client: %v", err))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	errorsByKind := map[string]string{}
	applications, err := listArgoObjects(ctx, client, argoApplicationGVR)
	if err != nil {
		errorsByKind["applications"] = err.Error()
	}
	appSets, err := listArgoObjects(ctx, client, argoAppSetGVR)
	if err != nil {
		errorsByKind["applicationSets"] = err.Error()
	}
	projects, err := listArgoObjects(ctx, client, argoAppProjectGVR)
	if err != nil {
		errorsByKind["appProjects"] = err.Error()
	}

	resp := argoCDAdminResponse{
		ContextName:       adminContext,
		CurrentContext:    k8s.GetContextName(),
		Applications:      applications,
		ApplicationSets:   appSets,
		AppProjects:       projects,
		AvailableContexts: availableContexts,
	}
	if len(errorsByKind) > 0 {
		resp.Errors = errorsByKind
	}

	s.writeJSON(w, resp)
}

func (s *Server) handleArgoCDDestinationPods(w http.ResponseWriter, r *http.Request) {
	if !s.requireConnected(w) {
		return
	}

	contextName := strings.TrimSpace(r.URL.Query().Get("context"))
	namespace := strings.TrimSpace(r.URL.Query().Get("namespace"))
	if namespace == "" {
		s.writeError(w, http.StatusBadRequest, "namespace is required")
		return
	}

	var client kubernetes.Interface
	if contextName == "" || contextName == k8s.GetContextName() {
		client = k8s.GetClient()
		contextName = k8s.GetContextName()
	} else {
		cfg, err := k8s.BuildRESTConfigForContext(contextName)
		if err != nil {
			s.writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to build destination cluster config: %v", err))
			return
		}
		client, err = kubernetes.NewForConfig(cfg)
		if err != nil {
			s.writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to create destination cluster client: %v", err))
			return
		}
	}
	if client == nil {
		s.writeError(w, http.StatusServiceUnavailable, "kubernetes client not available")
		return
	}

	workloadNames := map[string]bool{}
	for _, value := range strings.Split(r.URL.Query().Get("workloads"), ",") {
		value = strings.TrimSpace(value)
		if value != "" {
			workloadNames[value] = true
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	list, err := client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		s.writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to list destination pods: %v", err))
		return
	}

	pods := make([]argoDestinationPod, 0, len(list.Items))
	for _, pod := range list.Items {
		if len(workloadNames) > 0 && !podMatchesAnyWorkload(pod.Name, workloadNames) {
			continue
		}

		var restarts int32
		for _, status := range pod.Status.ContainerStatuses {
			restarts += status.RestartCount
		}
		pods = append(pods, argoDestinationPod{
			Name:       pod.Name,
			Namespace:  pod.Namespace,
			Phase:      string(pod.Status.Phase),
			Containers: len(pod.Spec.Containers),
			Restarts:   restarts,
		})
	}

	s.writeJSON(w, argoDestinationPodsResponse{
		ContextName: contextName,
		Namespace:   namespace,
		Pods:        pods,
	})
}

func podMatchesAnyWorkload(podName string, workloads map[string]bool) bool {
	for workload := range workloads {
		if podName == workload || strings.HasPrefix(podName, workload+"-") {
			return true
		}
	}
	return false
}

func resolveArgoCDAdminContext(r *http.Request) (string, []string, error) {
	requested := strings.TrimSpace(r.URL.Query().Get("context"))
	if requested == "" {
		requested = strings.TrimSpace(os.Getenv("RADAR_ARGOCD_CONTEXT"))
	}

	contexts, err := k8s.GetAvailableContexts()
	if err != nil {
		return "", nil, fmt.Errorf("failed to list kube contexts: %w", err)
	}

	available := make([]string, 0, len(contexts))
	for _, ctx := range contexts {
		available = append(available, ctx.Name)
	}
	sort.Strings(available)

	if requested != "" {
		for _, name := range available {
			if name == requested {
				return name, available, nil
			}
		}
		return "", available, fmt.Errorf("ArgoCD admin context %q not found", requested)
	}

	preferred := []string{"outcomes-eks-admin"}
	for _, candidate := range preferred {
		for _, name := range available {
			if name == candidate {
				return name, available, nil
			}
		}
	}
	for _, name := range available {
		if strings.Contains(strings.ToLower(name), "admin") {
			return name, available, nil
		}
	}

	return "", available, fmt.Errorf("no admin kube context found; set RADAR_ARGOCD_CONTEXT or pass ?context=<name>")
}

func listArgoObjects(ctx context.Context, client dynamic.Interface, gvr schema.GroupVersionResource) ([]any, error) {
	list, err := client.Resource(gvr).Namespace("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return []any{}, err
	}

	items := make([]any, 0, len(list.Items))
	for i := range list.Items {
		items = append(items, sanitizeUnstructured(&list.Items[i]))
	}
	return items, nil
}

func sanitizeUnstructured(obj *unstructured.Unstructured) map[string]any {
	cp := obj.DeepCopy()
	unstructured.RemoveNestedField(cp.Object, "metadata", "managedFields")
	unstructured.RemoveNestedField(cp.Object, "metadata", "annotations", "kubectl.kubernetes.io/last-applied-configuration")
	return cp.Object
}
