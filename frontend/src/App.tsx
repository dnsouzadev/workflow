import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "./components/Graph";
import { NodeStatus, WorkflowEdge, WorkflowNode, workflow } from "./workflow";
import "./App.css";

type WorkflowSummary = {
  workflow_id: string;
  name: string;
  description?: string | null;
  created_at: string;
  updated_at: string;
};

export default function App() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [runStatus, setRunStatus] = useState<"idle" | "queued" | "running" | "success" | "failed">("idle");
  const [jobId, setJobId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [nodes, setNodes] = useState<WorkflowNode[]>(() => workflow.nodes);
  const [edges, setEdges] = useState<WorkflowEdge[]>(() => workflow.edges);
  const [connectMode, setConnectMode] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState("Meu workflow");
  const [workflowDescription, setWorkflowDescription] = useState("");
  const [workflowList, setWorkflowList] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowMessage, setWorkflowMessage] = useState<string | null>(null);
  const [loadingWorkflows, setLoadingWorkflows] = useState(false);
  const [configValue, setConfigValue] = useState("");
  const [view, setView] = useState<"editor" | "dashboard" | "secrets" | "schedules" | "run-inspector">("editor");
  const [inspectingRunId, setInspectingRunId] = useState<string | null>(null);
  const [showInputModal, setShowInputModal] = useState(false);
  const [customInput, setCustomInput] = useState("[1, 2, 3, 4, 5]");

  const buildStatusMap = (status: NodeStatus, list = nodes) => Object.fromEntries(list.map((node) => [node.id, status])) as Record<string, NodeStatus>;
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeStatus>>(() => buildStatusMap("idle", workflow.nodes));
  const [nodeLogs, setNodeLogs] = useState<Record<string, string>>({});

  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const [editorMode, setEditorMode] = useState<"form" | "json">("form");

  const parsedConfig = useMemo(() => {
    try {
      return JSON.parse(configValue) || {};
    } catch (e) {
      return {};
    }
  }, [configValue]);

  const updateConfigField = (field: string, value: any) => {
    const updated = { ...parsedConfig, [field]: value };
    setConfigValue(JSON.stringify(updated, null, 2));
  };

  useEffect(() => {
    if (selectedNode) setConfigValue(JSON.stringify(selectedNode.data ?? {}, null, 2));
    else setConfigValue("");
  }, [selectedNode]);

  const handleSaveConfig = () => {
    if (!selectedNodeId) return;
    try {
      const parsed = JSON.parse(configValue);
      setNodes((prev) => prev.map((n) => (n.id === selectedNodeId ? { ...n, data: parsed } : n)));
      setWorkflowMessage("Configuração do node salva localmente.");
    } catch (err) { setEditorError("JSON inválido na configuração do node."); }
  };

  const statusLabels = { idle: "Parado", queued: "Na fila", running: "Executando", success: "Sucesso", failed: "Falha" } as const;
  const nodeStatusLabels: Record<NodeStatus, string> = { idle: "Parado", running: "Executando", success: "Sucesso", error: "Falha", skipped: "Pulado" };

  const apiHost = process.env.REACT_APP_API_HOST || window.location.hostname;
  const apiPort = process.env.REACT_APP_API_PORT || "8000";
  const apiBase = `${window.location.protocol}//${apiHost}:${apiPort}`;
  const wsUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${apiHost}:${apiPort}/ws/execute`;

  const buildWorkflowPayload = () => ({
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, x: node.x, y: node.y, data: node.data })),
    edges,
    config: { max_workers: 1, default_timeout_ms: 5000, default_retries: 0, retry_backoff_ms: 200 }
  });

  const hasPath = (start: string, target: string, currentEdges: WorkflowEdge[]): boolean => {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node === target) return true;
      if (!visited.has(node)) {
        visited.add(node);
        const children = currentEdges.filter(e => e.from === node).map(e => e.to);
        queue.push(...children);
      }
    }
    return false;
  };

  const handleCreateEdge = (from: string, to: string) => {
    if (from === to || edges.some((edge) => edge.from === from && edge.to === to)) return;
    if (hasPath(to, from, edges)) {
      setEditorError("Conexão inválida: loops/ciclos não são permitidos em um workflow (DAG).");
      return;
    }
    setEditorError(null);
    setEdges((prev) => [...prev, { from, to }]);
  };

  const handleNodePositionChange = (nodeId: string, x: number, y: number) => {
    setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, x, y } : node)));
  };

  const nextNodeIdRef = useRef(20);

  const handleDropNode = (nodeType: string, x: number, y: number) => {
    const id = String(nextNodeIdRef.current++);
    const newNode: WorkflowNode = { id, type: nodeType, x, y };
    setNodes((prev) => [...prev, newNode]);
    setNodeStatus((prev) => ({ ...prev, [id]: "idle" }));
    setSelectedNodeId(id);
  };

  const fetchWorkflows = useCallback(async () => {
    setLoadingWorkflows(true);
    try {
      const res = await fetch(`${apiBase}/workflows`);
      const data = await res.json();
      setWorkflowList(data.workflows ?? []);
    } catch (err) { console.error(err); } finally { setLoadingWorkflows(false); }
  }, [apiBase]);

  useEffect(() => { fetchWorkflows(); }, [fetchWorkflows]);

  const handleSaveWorkflow = async (mode: "create" | "update") => {
    if (!workflowName.trim()) return;
    const payload = { name: workflowName.trim(), description: workflowDescription.trim() || undefined, payload: buildWorkflowPayload() };
    try {
      const endpoint = mode === "update" && selectedWorkflowId ? `${apiBase}/workflows/${selectedWorkflowId}` : `${apiBase}/workflows`;
      const res = await fetch(endpoint, { method: mode === "update" ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (data.workflow_id) setSelectedWorkflowId(data.workflow_id);
      setWorkflowMessage("Workflow salvo com sucesso.");
      fetchWorkflows();
    } catch (err) { console.error(err); }
  };

  const handleLoadWorkflow = async (id: string) => {
    try {
      const res = await fetch(`${apiBase}/workflows/${id}`);
      const data = await res.json();
      setNodes(data.payload.nodes);
      setEdges(data.payload.edges);
      setWorkflowName(data.name);
      setWorkflowDescription(data.description || "");
      setSelectedWorkflowId(id);
    } catch (err) { console.error(err); }
  };

  const handleDeleteWorkflow = async () => {
    if (!selectedWorkflowId) return;
    if (!window.confirm("Deseja realmente excluir este workflow e todos os seus agendamentos?")) return;
    try {
      const res = await fetch(`${apiBase}/workflows/${selectedWorkflowId}`, { method: "DELETE" });
      if (res.ok) {
        setWorkflowMessage("Workflow excluído com sucesso.");
        setSelectedWorkflowId(null);
        setWorkflowName("Meu workflow");
        setWorkflowDescription("");
        setNodes(workflow.nodes);
        setEdges(workflow.edges);
        fetchWorkflows();
      } else {
        setEditorError("Falha ao excluir o workflow.");
      }
    } catch (err) {
      console.error(err);
      setEditorError("Erro de conexão ao excluir o workflow.");
    }
  };

  const runWorkflow = (customPayload?: any) => {
    if (socketRef.current) {
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      socketRef.current.close();
    }
    setLoading(true);
    setResult(null);
    setNodeStatus(buildStatusMap("idle", nodes));
    setNodeLogs({});
    setRunStatus("queued");
    setEditorError(null);
    setRunId(null);
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", workflow: customPayload || buildWorkflowPayload() }));
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      switch (payload.type) {
        case "run_queued": setJobId(payload.job_id); break;
        case "run_started": if (payload.run_id) setRunId(payload.run_id); break;
        case "node_started": setNodeStatus((prev) => ({ ...prev, [payload.node_id]: "running" })); setRunStatus("running"); break;
        case "node_succeeded": setNodeStatus((prev) => ({ ...prev, [payload.node_id]: "success" })); if (payload.logs) setNodeLogs((prev) => ({ ...prev, [payload.node_id]: payload.logs })); break;
        case "node_failed": setNodeStatus((prev) => ({ ...prev, [payload.node_id]: "error" })); if (payload.logs) setNodeLogs((prev) => ({ ...prev, [payload.node_id]: payload.logs })); break;
        case "node_skipped": setNodeStatus((prev) => ({ ...prev, [payload.node_id]: "skipped" })); break;
        case "run_finished": setResult(payload); setRunId(payload.run_id); setRunStatus(payload.status === "success" ? "success" : "failed"); setLoading(false); break;
        default: break;
      }
    };
    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
      setEditorError("Falha na conexão com o servidor de execução.");
      setRunStatus("failed");
      setLoading(false);
    };
    ws.onclose = () => {
      setLoading((prev) => {
        if (prev) {
          setRunStatus("failed");
          setEditorError("Conexão com o servidor encerrada antes do término do workflow.");
        }
        return false;
      });
    };
  };

  const cancelWorkflow = async () => {
    if (!runId) return;
    try {
      const res = await fetch(`${apiBase}/runs/${runId}/cancel`, { method: "POST" });
      if (res.ok) {
        setWorkflowMessage("Execução cancelada pelo usuário.");
        setRunStatus("failed");
        setLoading(false);
      } else {
        setEditorError("Falha ao cancelar execução.");
      }
    } catch (err) {
      console.error(err);
      setEditorError("Erro de conexão ao cancelar execução.");
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <div><div className="app-title">Workflow Studio</div><div className="app-subtitle">Real-time automation & triggers</div></div>
        <div className="header-nav">
          <button className={`button ${view === "editor" ? "active" : "secondary"}`} onClick={() => setView("editor")}>Editor</button>
          <button className={`button ${view === "dashboard" ? "active" : "secondary"}`} onClick={() => setView("dashboard")}>Dashboard</button>
          <button className={`button ${view === "secrets" ? "active" : "secondary"}`} onClick={() => setView("secrets")}>Secrets</button>
          <button className={`button ${view === "schedules" ? "active" : "secondary"}`} onClick={() => setView("schedules")}>Triggers</button>
        </div>
        <div className="header-meta">
          <span className={`status-pill status-${runStatus}`}>{statusLabels[runStatus]}</span>
          <span className="meta-item">Run {runId ? runId.slice(0, 8) : "-"}</span>
        </div>
      </header>

      {editorError && <div className="banner banner-error">{editorError}</div>}
      {workflowMessage && <div className="banner banner-info">{workflowMessage}</div>}

      {view === "dashboard" ? <Dashboard apiBase={apiBase} onInspectRun={(id) => { setInspectingRunId(id); setView("run-inspector"); }} />
      : view === "secrets" ? <SecretsManager apiBase={apiBase} />
      : view === "schedules" ? <SchedulesManager apiBase={apiBase} workflows={workflowList} />
      : view === "run-inspector" ? <RunInspector apiBase={apiBase} runId={inspectingRunId} onBack={() => setView("dashboard")} />
      : (
        <>
          <section className="toolbar panel">
            <div className="toolbar-left">
              <button className="button primary" onClick={() => runWorkflow()} disabled={loading}>{loading ? "Executando..." : "Executar Workflow"}</button>
              {!loading && (
                <button className="button secondary" onClick={() => setShowInputModal(true)}>Executar com Entrada...</button>
              )}
              {loading && runId && (
                <button className="button secondary" onClick={cancelWorkflow} style={{ color: "#ef4444", borderColor: "#7f1d1d" }}>Cancelar Execução</button>
              )}
              <button className={`button ${connectMode ? "active" : "secondary"}`} onClick={() => setConnectMode(prev => !prev)}>{connectMode ? "Conectar ON" : "Conectar OFF"}</button>
            </div>
            <div className="toolbar-right">
              <div className="stat"><span className="stat-label">Nodes</span><span className="stat-value">{nodes.length}</span></div>
              <div className="stat"><span className="stat-label">Edges</span><span className="stat-value">{edges.length}</span></div>
            </div>
          </section>

          <section className="panel workflow-panel" style={{ marginBottom: "20px" }}>
            <div className="workflow-form" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div className="field"><label>Nome</label><input value={workflowName} onChange={e => setWorkflowName(e.target.value)} /></div>
              <div className="field"><label>Descrição</label><input value={workflowDescription} onChange={e => setWorkflowDescription(e.target.value)} /></div>
            </div>
            <div className="workflow-footer" style={{ display: "flex", justifyContent: "space-between", marginTop: "10px" }}>
              <div style={{ display: "flex", gap: "10px" }}>
                <button className="button primary" onClick={() => handleSaveWorkflow("create")}>Salvar novo</button>
                <button className="button active" onClick={() => handleSaveWorkflow("update")} disabled={!selectedWorkflowId}>Atualizar selecionado</button>
                <button className="button secondary" onClick={handleDeleteWorkflow} disabled={!selectedWorkflowId} style={{ color: "#ef4444", borderColor: "#7f1d1d" }}>Excluir selecionado</button>
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <select value={selectedWorkflowId ?? ""} onChange={e => { const id = e.target.value; if(id) handleLoadWorkflow(id); }}>
                  <option value="">Carregar salvo</option>
                  {workflowList.map(item => <option key={item.workflow_id} value={item.workflow_id}>{item.name}</option>)}
                </select>
              </div>
            </div>
          </section>

          <div className="layout">
            <aside className="panel">
              <div className="panel-title">Palette</div>
              <div className="palette-list">
                {["input", "filter", "http_request", "json_transform", "condition", "delay", "script", "slack_webhook", "discord_webhook", "output"].map(type => (
                  <div key={type} className="palette-item" draggable onDragStart={e => e.dataTransfer.setData("application/node-type", type)}>
                    <span className="palette-dot" /><div><div className="palette-name">{type}</div></div>
                  </div>
                ))}
              </div>
            </aside>
            <main className="panel canvas-panel">
              <div className="graph-wrapper">
                <Graph nodes={nodes} edges={edges} nodeStatus={nodeStatus} connectMode={connectMode} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId} onNodePositionChange={handleNodePositionChange} onCreateEdge={handleCreateEdge} onDropNode={handleDropNode} />
              </div>
            </main>
            <aside className="panel" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div className="panel-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Node details</span>
                {selectedNode && (
                  <div style={{ display: "flex", gap: "4px" }}>
                    <button 
                      className={`button small ${editorMode === "form" ? "primary" : "secondary"}`}
                      onClick={() => setEditorMode("form")}
                      style={{ padding: "4px 8px", fontSize: "10px" }}
                    >
                      Form
                    </button>
                    <button 
                      className={`button small ${editorMode === "json" ? "primary" : "secondary"}`}
                      onClick={() => setEditorMode("json")}
                      style={{ padding: "4px 8px", fontSize: "10px" }}
                    >
                      JSON
                    </button>
                  </div>
                )}
              </div>
              {selectedNode ? (
                <div className="details">
                  <div className="detail-row"><span>ID</span><span className="mono">{selectedNode.id}</span></div>
                  <div className="detail-row"><span>Tipo</span><span>{selectedNode.type}</span></div>
                  
                  {nodeLogs[selectedNode.id] && (
                    <>
                      <div className="panel-divider" />
                      <pre className="code-block logs-block" style={{ maxHeight: "100px" }}>{nodeLogs[selectedNode.id]}</pre>
                    </>
                  )}
                  
                  <div className="panel-divider" />
                  
                  {editorMode === "json" ? (
                    <textarea 
                      className="config-editor" 
                      value={configValue} 
                      onChange={e => setConfigValue(e.target.value)} 
                      rows={8} 
                    />
                  ) : (
                    <div className="form-fields">
                      {selectedNode.type === "input" && (
                        <div className="field">
                          <label>Valor / Payload (JSON/Texto)</label>
                          <textarea 
                            className="config-editor" 
                            value={typeof parsedConfig.value === 'object' ? JSON.stringify(parsedConfig.value, null, 2) : parsedConfig.value ?? ""} 
                            onChange={e => {
                              let val = e.target.value;
                              try { val = JSON.parse(val); } catch(err) {}
                              updateConfigField("value", val);
                            }}
                            rows={4}
                          />
                        </div>
                      )}
                      
                      {selectedNode.type === "filter" && (
                        <>
                          <div className="field" style={{ marginBottom: "8px" }}>
                            <label>Limiar (Threshold)</label>
                            <input 
                              type="number"
                              className="config-editor"
                              style={{ width: "100%" }}
                              value={parsedConfig.threshold ?? 2} 
                              onChange={e => updateConfigField("threshold", Number(e.target.value))}
                            />
                          </div>
                          <div className="field">
                            <label>Chave do Objeto (Opcional)</label>
                            <input 
                              type="text"
                              className="config-editor"
                              style={{ width: "100%" }}
                              placeholder="Ex: items"
                              value={parsedConfig.key ?? ""} 
                              onChange={e => updateConfigField("key", e.target.value || undefined)}
                            />
                          </div>
                        </>
                      )}
                      
                      {selectedNode.type === "http_request" && (
                        <>
                          <div className="field" style={{ marginBottom: "8px" }}>
                            <label>URL</label>
                            <input 
                              type="text"
                              className="config-editor"
                              style={{ width: "100%" }}
                              placeholder="https://api.github.com/..."
                              value={parsedConfig.url ?? ""} 
                              onChange={e => updateConfigField("url", e.target.value)}
                            />
                          </div>
                          <div className="field" style={{ marginBottom: "8px" }}>
                            <label>Método</label>
                            <select 
                              className="config-editor"
                              style={{ width: "100%", height: "38px" }}
                              value={parsedConfig.method ?? "GET"} 
                              onChange={e => updateConfigField("method", e.target.value)}
                            >
                              <option value="GET">GET</option>
                              <option value="POST">POST</option>
                              <option value="PUT">PUT</option>
                              <option value="DELETE">DELETE</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>Headers (JSON)</label>
                            <textarea 
                              className="config-editor" 
                              placeholder='{"Authorization": "Bearer xxx"}'
                              value={parsedConfig.headers ? JSON.stringify(parsedConfig.headers, null, 2) : ""} 
                              onChange={e => {
                                try { updateConfigField("headers", JSON.parse(e.target.value)); } catch(err) {}
                              }}
                              rows={3}
                            />
                          </div>
                        </>
                      )}
                      
                      {selectedNode.type === "json_transform" && (
                        <div className="field">
                          <label>Template (JSON/Texto)</label>
                          <textarea 
                            className="config-editor" 
                            placeholder='{"resultado": "{full_name} tem {stargazers_count} estrelas"}'
                            value={typeof parsedConfig.template === 'object' ? JSON.stringify(parsedConfig.template, null, 2) : parsedConfig.template ?? ""} 
                            onChange={e => {
                              let val = e.target.value;
                              try { val = JSON.parse(val); } catch(err) {}
                              updateConfigField("template", val);
                            }}
                            rows={6}
                          />
                        </div>
                      )}
                      
                      {selectedNode.type === "script" && (
                        <div className="field">
                          <label>Script Python (`data` / `result` / `log` / `json` )</label>
                          <textarea 
                            className="config-editor" 
                            style={{ height: "180px" }}
                            value={parsedConfig.code ?? "result = data"} 
                            onChange={e => updateConfigField("code", e.target.value)}
                            rows={10}
                          />
                        </div>
                      )}
                      
                      {selectedNode.type === "condition" && (
                        <div className="field">
                          <label>Expressão Condicional Python</label>
                          <input 
                            type="text"
                            className="config-editor"
                            style={{ width: "100%" }}
                            placeholder="data.get('stars', 0) > 100"
                            value={parsedConfig.expression ?? ""} 
                            onChange={e => updateConfigField("expression", e.target.value)}
                          />
                        </div>
                      )}
                      
                      {selectedNode.type === "delay" && (
                        <div className="field">
                          <label>Atraso (Segundos)</label>
                          <input 
                            type="number"
                            className="config-editor"
                            style={{ width: "100%" }}
                            value={parsedConfig.seconds ?? 1} 
                            onChange={e => updateConfigField("seconds", Number(e.target.value))}
                          />
                        </div>
                      )}
                      
                      {selectedNode.type === "slack_webhook" && (
                        <>
                          <div className="field" style={{ marginBottom: "8px" }}>
                            <label>Webhook URL (ou secret:NOME)</label>
                            <input 
                              type="text"
                              className="config-editor"
                              style={{ width: "100%" }}
                              placeholder="secret:SLACK_WEBHOOK"
                              value={parsedConfig.webhook_url ?? ""} 
                              onChange={e => updateConfigField("webhook_url", e.target.value)}
                            />
                          </div>
                          <div className="field">
                            <label>Mensagem</label>
                            <textarea 
                              className="config-editor" 
                              value={parsedConfig.text ?? "Workflow notification: {data}"} 
                              onChange={e => updateConfigField("text", e.target.value)}
                              rows={4}
                            />
                          </div>
                        </>
                      )}
                      
                      {selectedNode.type === "discord_webhook" && (
                        <>
                          <div className="field" style={{ marginBottom: "8px" }}>
                            <label>Webhook URL (ou secret:NOME)</label>
                            <input 
                              type="text"
                              className="config-editor"
                              style={{ width: "100%" }}
                              placeholder="secret:DISCORD_WEBHOOK"
                              value={parsedConfig.webhook_url ?? ""} 
                              onChange={e => updateConfigField("webhook_url", e.target.value)}
                            />
                          </div>
                          <div className="field">
                            <label>Mensagem</label>
                            <textarea 
                              className="config-editor" 
                              value={parsedConfig.content ?? "Workflow notification: {data}"} 
                              onChange={e => updateConfigField("content", e.target.value)}
                              rows={4}
                            />
                          </div>
                        </>
                      )}
                      
                      {selectedNode.type === "output" && (
                        <div className="muted" style={{ padding: "10px 0" }}>
                          Nó de saída. Sem parâmetros extras.
                        </div>
                      )}
                    </div>
                  )}
                  
                  <button className="button secondary small" onClick={handleSaveConfig} style={{ marginTop: "12px", width: "100%" }}>Salvar Configuração</button>
                  {selectedNodeId && result?.all_outputs?.[selectedNodeId] && (
                    <>
                      <div className="panel-divider" />
                      <div className="panel-title" style={{ fontSize: "11px" }}>Último Resultado</div>
                      <pre className="code-block" style={{ maxHeight: "150px" }}>{JSON.stringify(result.all_outputs[selectedNodeId], null, 2)}</pre>
                    </>
                  )}
                </div>
              ) : <div className="muted">Selecione um node.</div>}
            </aside>
          </div>
        </>
      )}

      {showInputModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="panel-title" style={{ fontSize: "18px", marginBottom: "4px" }}>Executar com Entrada Customizada</div>
            <div className="muted" style={{ marginBottom: "10px" }}>Insira o valor ou objeto JSON que será injetado no nó do tipo `input` no início da execução.</div>
            <textarea
              className="config-editor"
              value={customInput}
              onChange={e => setCustomInput(e.target.value)}
              rows={8}
              style={{ height: "150px" }}
              placeholder='Ex: {"repositorio": "gemini-cli"}'
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "10px" }}>
              <button className="button secondary" onClick={() => setShowInputModal(false)}>Cancelar</button>
              <button 
                className="button primary" 
                onClick={() => {
                  let parsed = customInput;
                  try {
                    parsed = JSON.parse(customInput);
                  } catch(e) {}
                  
                  const clonedPayload = buildWorkflowPayload();
                  const inputNode = clonedPayload.nodes.find(n => n.type === "input");
                  if (inputNode) {
                    inputNode.data = { ...inputNode.data, value: parsed };
                  } else {
                    if (clonedPayload.nodes.length > 0) {
                      clonedPayload.nodes[0].data = { ...clonedPayload.nodes[0].data, value: parsed };
                    }
                  }
                  
                  setShowInputModal(false);
                  runWorkflow(clonedPayload);
                }}
              >
                Executar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunInspector({ apiBase, runId, onBack }: { apiBase: string, runId: string | null, onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { if (runId) fetch(`${apiBase}/runs/${runId}`).then(r => r.json()).then(setData); }, [apiBase, runId]);
  if (!data) return <div className="panel">Carregando detalhes...</div>;
  return (
    <div className="inspector">
      <button className="button secondary" onClick={onBack} style={{ marginBottom: "20px" }}>← Dashboard</button>
      <div className="panel" style={{ marginBottom: "20px" }}>
        <div className="panel-title">Run {runId?.slice(0, 8)}</div>
        <div className="detail-row"><span>Status</span><span className={`status-pill status-${data.run.status}`}>{data.run.status}</span></div>
        <div className="detail-row"><span>Start</span><span>{new Date(data.run.started_at).toLocaleString()}</span></div>
      </div>
      <div style={{ display: "grid", gap: "10px" }}>
        {data.nodes.map((node: any) => (
          <div key={node.node_id + node.attempt} className="panel">
            <div style={{ display: "flex", justifyContent: "space-between" }}><div className="panel-title">Node {node.node_id} (Attempt {node.attempt})</div><span className={`status-pill status-${node.status} small`}>{node.status}</span></div>
            {node.logs && <pre className="code-block logs-block">{node.logs}</pre>}
            {node.output && <pre className="code-block">{JSON.stringify(node.output, null, 2)}</pre>}
            {node.error && <div className="error-text">{node.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SchedulesManager({ apiBase, workflows }: { apiBase: string, workflows: WorkflowSummary[] }) {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("*/5 * * * *");
  const [workflowId, setWorkflowId] = useState("");

  const fetchSchedules = useCallback(async () => {
    const res = await fetch(`${apiBase}/schedules`);
    const data = await res.json();
    setSchedules(data.schedules || []);
  }, [apiBase]);

  useEffect(() => { fetchSchedules(); }, [fetchSchedules]);

  const handleSave = async () => {
    if (!name || !cron || !workflowId) return;
    await fetch(`${apiBase}/schedules`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, cron, workflow_id: workflowId }) });
    setName(""); fetchSchedules();
  };

  const handleToggle = async (scheduleId: string, currentStatus: boolean | number) => {
    const nextStatus = !currentStatus;
    try {
      await fetch(`${apiBase}/schedules/${scheduleId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextStatus })
      });
      fetchSchedules();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="schedules">
      <div className="panel" style={{ marginBottom: "20px" }}>
        <div className="panel-title">Novo Agendamento</div>
        <div className="workflow-form" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: "10px", alignItems: "end" }}>
          <div className="field"><label>Nome</label><input value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="field"><label>Cron (Standard Crontab)</label><input value={cron} onChange={e => setCron(e.target.value)} /></div>
          <div className="field"><label>Workflow</label>
            <select value={workflowId} onChange={e => setWorkflowId(e.target.value)}>
              <option value="">Selecionar</option>
              {workflows.map(w => <option key={w.workflow_id} value={w.workflow_id}>{w.name}</option>)}
            </select>
          </div>
          <button className="button primary" onClick={handleSave}>Agendar</button>
        </div>
      </div>
      <div className="panel">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ textAlign: "left" }}><th>Nome</th><th>Cron</th><th>Status</th><th>Last Run</th><th>Ações</th></tr></thead>
          <tbody>
            {schedules.map(s => (
              <tr key={s.schedule_id} style={{ borderBottom: "1px solid #1e293b" }}>
                <td style={{ padding: "10px 0" }}>{s.name}</td>
                <td><code>{s.cron}</code></td>
                <td>
                  <label className="toggle-switch" style={{ display: "inline-block" }}>
                    <input 
                      type="checkbox" 
                      checked={!!s.enabled} 
                      onChange={() => handleToggle(s.schedule_id, s.enabled)} 
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </td>
                <td>{s.last_run_at ? new Date(s.last_run_at).toLocaleString() : "-"}</td>
                <td><button className="button secondary small" onClick={async () => { await fetch(`${apiBase}/schedules/${s.schedule_id}`, { method: "DELETE" }); fetchSchedules(); }}>Remover</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SecretsManager({ apiBase }: { apiBase: string }) {
  const [secrets, setSecrets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSecret, setEditingSecret] = useState<{name: string, value: string} | null>(null);

  const fetchSecrets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/secrets`);
      const data = await res.json();
      setSecrets(data.secrets || []);
    } catch (err) {
      console.error("Fetch secrets error:", err);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => { fetchSecrets(); }, [fetchSecrets]);

  const handleSave = async (name: string, value: string) => {
    if (!name || !value) return;
    try {
      await fetch(`${apiBase}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      fetchSecrets();
      setEditingSecret(null);
    } catch (err) {
      console.error("Save secret error:", err);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await fetch(`${apiBase}/secrets/${name}`, { method: "DELETE" });
      fetchSecrets();
    } catch (err) {
      console.error("Delete secret error:", err);
    }
  };

  const isEnabled = (name: string) => secrets.some(s => s.name === name);

  const IntegrationCard = ({ id, name, icon, secretKey, placeholder }: any) => {
    const enabled = isEnabled(secretKey);
    const [showConfig, setShowConfig] = useState(false);
    const [tempValue, setTempValue] = useState("");

    return (
      <div className={`integration-card ${enabled ? "enabled" : ""}`}>
        <div className="integration-header">
          <div className="integration-info">
            <div className="integration-icon">{icon}</div>
            <div>
              <div className="integration-name">{name}</div>
              <span className={`integration-status ${enabled ? "active" : ""}`}>
                {enabled ? "Configurado" : "Desconectado"}
              </span>
            </div>
          </div>
          <label className="toggle-switch">
            <input 
              type="checkbox" 
              checked={enabled} 
              onChange={() => {
                if (enabled) handleDelete(secretKey);
                else setShowConfig(true);
              }} 
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
        
        {(showConfig || (enabled && showConfig)) && (
          <div className="integration-config" style={{ marginTop: "10px" }}>
            <div className="field">
              <label style={{ fontSize: "11px" }}>Webhook URL / API Key</label>
              <input 
                type="password" 
                placeholder={placeholder}
                value={tempValue}
                onChange={e => setTempValue(e.target.value)}
                autoFocus
              />
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <button className="button primary small" onClick={() => { handleSave(secretKey, tempValue); setTempValue(""); setShowConfig(false); }}>Salvar</button>
              <button className="button secondary small" onClick={() => setShowConfig(false)}>Cancelar</button>
            </div>
          </div>
        )}
        
        {enabled && !showConfig && (
          <button className="button secondary small" onClick={() => setShowConfig(true)} style={{ marginTop: "8px" }}>
            Editar Configuração
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h2 style={{ margin: 0 }}>Integrações e Configurações</h2>
        <p className="muted">Conecte o Workflow Studio com suas ferramentas favoritas.</p>
      </div>

      <div className="settings-section-title">Serviços Populares</div>
      <div className="integrations-grid">
        <IntegrationCard 
          id="slack" 
          name="Slack" 
          icon="#" 
          secretKey="SLACK_WEBHOOK" 
          placeholder="https://hooks.slack.com/services/..."
        />
        <IntegrationCard 
          id="discord" 
          name="Discord" 
          icon="D" 
          secretKey="DISCORD_WEBHOOK" 
          placeholder="https://discord.com/api/webhooks/..."
        />
        <IntegrationCard 
          id="github" 
          name="GitHub" 
          icon="G" 
          secretKey="GITHUB_TOKEN" 
          placeholder="ghp_xxxxxxxxxxxx"
        />
        <IntegrationCard 
          id="google-sheets" 
          name="Google Sheets" 
          icon="S" 
          secretKey="GOOGLE_SHEETS_KEY" 
          placeholder="API Key ou JSON de Credenciais"
        />
      </div>

      <div className="settings-section-title">Todas as Secrets</div>
      <div className="panel">
        <div className="muted" style={{ marginBottom: "16px" }}>
          Gerenciamento manual de chaves. Use <code>secret:NOME</code> nos nodes.
        </div>
        
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #1e293b" }}>
              <th style={{ padding: "12px 8px" }}>Nome</th>
              <th>Status</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {secrets.map(s => (
              <tr key={s.name} style={{ borderBottom: "1px solid #0f172a" }}>
                <td className="mono" style={{ padding: "12px 8px" }}>{s.name}</td>
                <td><span className="status-pill success small">Salva</span></td>
                <td>
                  <button className="button secondary small" onClick={() => handleDelete(s.name)} style={{ color: "#ef4444" }}>Excluir</button>
                </td>
              </tr>
            ))}
            {secrets.length === 0 && (
              <tr><td colSpan={3} style={{ padding: "20px", textAlign: "center" }} className="muted">Nenhuma chave personalizada salva.</td></tr>
            )}
          </tbody>
        </table>
        
        <div style={{ marginTop: "20px", borderTop: "1px solid #1e293b", paddingTop: "20px" }}>
          <div className="panel-title" style={{ fontSize: "14px" }}>Adicionar Nova Chave</div>
          <div className="workflow-form" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: "10px", alignItems: "end", marginTop: "10px" }}>
            <div className="field">
              <label>Nome</label>
              <input id="new-secret-name" placeholder="EX: OPENAI_KEY" />
            </div>
            <div className="field">
              <label>Valor</label>
              <input id="new-secret-value" type="password" />
            </div>
            <button className="button primary" onClick={() => {
              const nameEl = document.getElementById("new-secret-name") as HTMLInputElement;
              const valEl = document.getElementById("new-secret-value") as HTMLInputElement;
              handleSave(nameEl.value, valEl.value);
              nameEl.value = ""; valEl.value = "";
            }}>Adicionar</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Dashboard({ apiBase, onInspectRun }: { apiBase: string, onInspectRun: (id: string) => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([fetch(`${apiBase}/runs?limit=50`), fetch(`${apiBase}/stats/daily`)]);
      const rd = await r.json(); const sd = await s.json();
      setRuns(rd.runs || []); setStats(sd.stats || []);
    } catch (err) { console.error(err); }
  }, [apiBase]);

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 5000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const summary = {
    total: runs.length,
    success: runs.filter(r => r.status === "success").length,
    failed: runs.filter(r => r.status === "failed").length
  };

  const maxCount = Math.max(...stats.map(s => s.count), 1);

  return (
    <div className="dashboard">
      <div className="dashboard-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "20px" }}>
        <div className="panel stat-card"><div className="stat-label">Total Runs</div><div className="stat-value">{summary.total}</div></div>
        <div className="panel stat-card green"><div className="stat-label">Sucessos</div><div className="stat-value" style={{ color: "#22c55e" }}>{summary.success}</div></div>
        <div className="panel stat-card red"><div className="stat-label">Falhas</div><div className="stat-value" style={{ color: "#ef4444" }}>{summary.failed}</div></div>
      </div>

      <div className="panel" style={{ marginTop: "20px" }}>
        <div className="panel-title">Run Volume (7 Days)</div>
        <div style={{ display: "flex", alignItems: "flex-end", height: "120px", gap: "12px", padding: "10px 0" }}>
          {stats.map((s, i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ width: "100%", background: s.status === "success" ? "#22c55e" : "#ef4444", height: `${(s.count / maxCount) * 100}%`, borderRadius: "4px 4px 0 0", minHeight: "4px" }} />
              <div style={{ fontSize: "10px", marginTop: "5px", color: "#94a3b8" }}>{s.date.split("-")[2]}</div>
            </div>
          ))}
          {stats.length === 0 && <div className="muted">No data.</div>}
        </div>
      </div>

      <div className="panel" style={{ marginTop: "20px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #1e293b" }}><th>Run ID</th><th>Status</th><th>Started</th><th>Action</th></tr></thead>
          <tbody>
            {runs.map(run => (
              <tr key={run.run_id} style={{ borderBottom: "1px solid #0f172a" }}>
                <td className="mono" style={{ padding: "10px 0" }}>{run.run_id.slice(0, 8)}</td>
                <td><span className={`status-pill status-${run.status} small`}>{run.status}</span></td>
                <td>{new Date(run.started_at).toLocaleString()}</td>
                <td><button className="button secondary small" onClick={() => onInspectRun(run.run_id)}>Inspect</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
