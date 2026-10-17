package rt

import "net/http"

// The agent interface (lang/runtime/agent.ts): the spec's actions and views over JSON and
// MCP, for tokens people issue.
type Agents struct{ sv *Server }

func NewAgents(sv *Server) *Agents { return &Agents{sv: sv} }

func (a *Agents) Handle(w http.ResponseWriter, r *HTTPReq, who Who, sameOrigin bool) bool {
	return false
}
