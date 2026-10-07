import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  BUILTIN_LABELS,
  newId,
  toolCountOf,
  type AgentFlow,
  type AgentModel,
  type AgentPlan,
  type BuiltinTool,
  type CatalogServer,
  type FlowNode,
  type PlannedAgent,
} from "./api.js";

// The execution flow as a canvas: steps (Input, agents, routers, tool steps,
// Output) and the connections between them. Used to edit a plan before it's
// created, and read-only to show an existing agent's flow.

type StepType = FlowNode["type"];

const MODELS: { id: AgentModel; label: string }[] = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

const PALETTE: { type: StepType; label: string; hint: string }[] = [
  { type: "agent", label: "Agent", hint: "A model with instructions and tools" },
  { type: "router", label: "Router", hint: "Picks one path by a rule" },
  { type: "tool", label: "Tool step", hint: "Calls one specific tool" },
  { type: "output", label: "Output", hint: "Replies to the user" },
  { type: "input", label: "Input", hint: "Where the request comes in" },
];

const TYPE_LABEL: Record<StepType, string> = { input: "Input", output: "Output", agent: "Agent", router: "Router", tool: "Tool" };
const DRAG_TYPE = "application/x-altship-step";

interface StepData extends Record<string, unknown> {
  step: FlowNode;
  title: string;
  subtitle: string;
}
type StepNode = Node<StepData, "step">;

function toolName(step: FlowNode): string {
  return step.tool ? step.tool.tool : step.builtinTool ? BUILTIN_LABELS[step.builtinTool.tool] : "No tool";
}

function describe(step: FlowNode, agents: Map<string, PlannedAgent>): { title: string; subtitle: string } {
  switch (step.type) {
    case "input":
      return { title: "Input", subtitle: "The user's request" };
    case "output":
      return { title: "Output", subtitle: "The reply to the user" };
    case "agent": {
      const agent = agents.get(step.agentKey ?? "");
      const tools = agent ? toolCountOf(agent) : 0;
      const model = MODELS.find((m) => m.id === agent?.model)?.label ?? "";
      return { title: agent?.name ?? "Agent", subtitle: `${model} · ${tools} tool${tools === 1 ? "" : "s"}` };
    }
    case "router":
      return { title: step.label || "Router", subtitle: step.rule || "Add a rule" };
    case "tool":
      return { title: step.label || toolName(step), subtitle: step.tool ? step.tool.server : "Built-in" };
  }
}

/** One step on the canvas. Routers get a connection point per route. */
function Step({ data, selected }: NodeProps<StepNode>) {
  const { step, title, subtitle } = data;
  return (
    <div className={`flow-step flow-${step.type}${selected ? " is-selected" : ""}`}>
      {step.type !== "input" && <Handle type="target" position={Position.Left} />}
      <div className="flow-step-head">
        <span className="role-tag">{TYPE_LABEL[step.type]}</span>
        <strong>{title}</strong>
      </div>
      <p className="flow-step-sub">{subtitle}</p>
      {step.type === "router" ? (
        <div className="flow-routes">
          {(step.routes ?? []).map((route) => (
            <div key={route.id} className="flow-route">
              <span>{route.label || "Unnamed route"}</span>
              <Handle type="source" position={Position.Right} id={route.id} />
            </div>
          ))}
        </div>
      ) : (
        step.type !== "output" && <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

const NODE_TYPES = { step: Step };

export interface FlowEditorProps {
  plan: AgentPlan;
  /** Omit for a read-only view. */
  onChange?: (plan: AgentPlan) => void;
  /** MCP servers chosen for this agent, by name: what tool steps can call. */
  servers?: Map<string, CatalogServer>;
  /** Built-in tools turned on for this agent. */
  allowedBuiltins?: BuiltinTool[];
  /** Undo and redo for changes to the plan; shown as buttons and bound to Ctrl/Cmd+Z. */
  history?: { undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean };
  /** The editor for an agent step (shared with the rest of the review screen). */
  renderAgent?: (agent: PlannedAgent, onChange: (patch: Partial<PlannedAgent>) => void) => ReactNode;
}

export default function FlowEditor(props: FlowEditorProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ plan, onChange, servers = new Map(), allowedBuiltins = [], history, renderAgent }: FlowEditorProps) {
  const flow = plan.flowGraph!;
  const readOnly = !onChange;
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const agents = useMemo(() => new Map(plan.agents.map((a) => [a.key, a])), [plan.agents]);

  // Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z (or Ctrl+Y) redoes, except while
  // typing in a field, where the keys keep their usual meaning for the text.
  useEffect(() => {
    if (!history) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) history.undo();
      else if ((key === "z" && event.shiftKey) || key === "y") history.redo();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history?.undo, history?.redo]);

  // React Flow keeps each node's measured size on the node object, so the
  // canvas nodes live in state and are refreshed from the flow, keeping
  // whatever React Flow added (size, selection).
  const [nodes, setNodes] = useState<StepNode[]>([]);
  useEffect(() => {
    setNodes((current) =>
      flow.nodes.map((step) => {
        const existing = current.find((n) => n.id === step.id);
        return {
          ...existing,
          id: step.id,
          type: "step" as const,
          position: step.position,
          deletable: !readOnly && step.type !== "input",
          data: { step, ...describe(step, agents) },
        };
      }),
    );
  }, [flow.nodes, agents, readOnly]);

  const edges: Edge[] = useMemo(
    () =>
      flow.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.route ?? null,
        selected: e.id === selectedEdge,
        deletable: !readOnly,
      })),
    [flow.edges, selectedEdge, readOnly],
  );

  const selectedId = nodes.find((n) => n.selected)?.id ?? null;
  const selected = flow.nodes.find((n) => n.id === selectedId) ?? null;

  const setFlow = (next: AgentFlow, nextAgents: PlannedAgent[] = plan.agents) => onChange?.({ ...plan, agents: nextAgents, flowGraph: next });
  const updateStep = (id: string, patch: Partial<FlowNode>) =>
    setFlow({ ...flow, nodes: flow.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });

  /** Tools a tool step can call: the chosen servers' tools and the built-ins that are on. */
  const toolOptions = useMemo(
    () => [
      ...[...servers.values()].flatMap((s) => s.tools.map((t) => ({ value: `mcp:${s.name}/${t.name}`, label: `${t.name} (${s.title})`, server: s.name, tool: t }))),
      ...allowedBuiltins.map((b) => ({ value: `builtin:${b}`, label: `${BUILTIN_LABELS[b]} (built-in)`, builtin: b })),
    ],
    [servers, allowedBuiltins],
  );

  function toolPatch(value: string): Partial<FlowNode> | null {
    const option = toolOptions.find((o) => o.value === value);
    if (!option) return null;
    if ("builtin" in option) return { tool: undefined, builtinTool: { tool: option.builtin as BuiltinTool, permission: "auto", reason: "" } };
    return {
      builtinTool: undefined,
      tool: { server: option.server, tool: option.tool.name, permission: option.tool.destructive ? "ask" : "auto", reason: "" },
    };
  }

  function addStep(type: StepType, position?: { x: number; y: number }) {
    setNotice(null);
    if (type === "input" && flow.nodes.some((n) => n.type === "input")) {
      return setNotice("A flow has one Input, and this one already has it.");
    }
    const at =
      position ??
      (() => {
        // Below everything that's there, in the middle of what's in view, so it never lands on another step.
        const box = wrapper.current?.getBoundingClientRect();
        const centre = box ? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) : { x: 0, y: 0 };
        const bottom = Math.max(...nodes.map((n) => n.position.y + (n.measured?.height ?? 70)), centre.y - 110);
        return { x: centre.x - 90, y: bottom + 40 };
      })();
    const step: FlowNode = { id: newId("step"), type, position: at };
    let nextAgents = plan.agents;

    if (type === "agent") {
      const names = new Set(plan.agents.map((a) => a.name.toLowerCase()));
      let name = "New agent";
      for (let n = 2; names.has(name.toLowerCase()); n++) name = `New agent ${n}`;
      const agent: PlannedAgent = {
        key: newId("agent").replace("_", "-"),
        name,
        role: "specialist",
        model: "claude-sonnet-5",
        description: "",
        instructions: "",
        tools: [],
        builtinTools: [],
      };
      step.agentKey = agent.key;
      nextAgents = [...plan.agents, agent];
    } else if (type === "router") {
      step.label = "Router";
      step.rule = "";
      step.routes = [
        { id: newId("route"), label: "Route 1" },
        { id: newId("route"), label: "Route 2" },
      ];
    } else if (type === "tool") {
      const first = toolOptions[0] && toolPatch(toolOptions[0].value);
      if (!first) return setNotice("There are no tools to call. Go back and pick an MCP server or turn on built-in tools first.");
      Object.assign(step, first);
    }

    setFlow({ ...flow, nodes: [...flow.nodes, step] }, nextAgents);
    setNodes((current) => current.map((n) => ({ ...n, selected: false })));
    // A step added from the toolbar can land outside the view; bring everything back in.
    if (!position) setTimeout(() => fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 50);
  }

  /** Removes steps (with their connections) and any other connections named. */
  function removeSteps(ids: string[], edgeIds: string[] = []) {
    const gone = new Set(ids);
    const goneEdges = new Set(edgeIds);
    const remaining = flow.nodes.filter((n) => !gone.has(n.id));
    // An agent leaves the plan with its last step.
    const stillUsed = new Set(remaining.map((n) => n.agentKey));
    setFlow(
      { ...flow, nodes: remaining, edges: flow.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target) && !goneEdges.has(e.id)) },
      plan.agents.filter((a) => stillUsed.has(a.key)),
    );
    if (selectedEdge && goneEdges.has(selectedEdge)) setSelectedEdge(null);
  }

  function onNodesChange(changes: NodeChange<StepNode>[]) {
    setNodes((current) => applyNodeChanges(changes, current));
    if (changes.some((c) => c.type === "select" && c.selected)) setSelectedEdge(null);
  }

  function onConnect(connection: Connection) {
    const source = flow.nodes.find((n) => n.id === connection.source);
    if (!source || !connection.target) return;
    const route = source.type === "router" ? (connection.sourceHandle ?? undefined) : undefined;
    if (flow.edges.some((e) => e.source === source.id && e.target === connection.target && e.route === route)) return;
    setFlow({ ...flow, edges: [...flow.edges, { id: newId("e"), source: source.id, target: connection.target, ...(route ? { route } : {}) }] });
  }

  function isValidConnection(connection: Connection | Edge): boolean {
    const source = flow.nodes.find((n) => n.id === connection.source);
    const target = flow.nodes.find((n) => n.id === connection.target);
    return Boolean(source && target && source.id !== target.id && source.type !== "output" && target.type !== "input");
  }

  function onDrop(event: DragEvent) {
    const type = event.dataTransfer.getData(DRAG_TYPE) as StepType;
    if (!type) return;
    event.preventDefault();
    addStep(type, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }

  const canvas = (
    <div className="flow-canvas" ref={wrapper} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_event, _node, dragged) => {
          const moved = new Map(dragged.map((n) => [n.id, n.position]));
          // A click that didn't move anything isn't a change (and shouldn't be an undo step).
          if (!flow.nodes.some((n) => moved.has(n.id) && (moved.get(n.id)!.x !== n.position.x || moved.get(n.id)!.y !== n.position.y))) return;
          setFlow({ ...flow, nodes: flow.nodes.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n)) });
        }}
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) =>
          removeSteps(
            deletedNodes.map((n) => n.id),
            deletedEdges.map((e) => e.id),
          )
        }
        onEdgeClick={(_event, edge) => {
          setSelectedEdge(edge.id);
          setNodes((current) => current.map((n) => ({ ...n, selected: false })));
        }}
        onPaneClick={() => setSelectedEdge(null)}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} color="#e4e4e4" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );

  if (readOnly) return <div className="flow-editor is-readonly">{canvas}</div>;

  return (
    <div className="flow-editor">
      <aside className="flow-palette" aria-label="Add a step">
        <h3>Add a step</h3>
        {PALETTE.map((item) => (
          <button
            key={item.type}
            type="button"
            className="flow-palette-item"
            title={item.hint}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, item.type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => addStep(item.type)}
          >
            <strong>+ {item.label}</strong>
          </button>
        ))}
        {history && (
          <div className="flow-history">
            <button type="button" className="flow-palette-item" disabled={!history.canUndo} onClick={history.undo} aria-label="Undo" title="Undo (Ctrl/⌘+Z)">
              <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 5 3.5 8.5 7 12" />
                <path d="M3.5 8.5h8a5 5 0 0 1 0 10H8" />
              </svg>
            </button>
            <button type="button" className="flow-palette-item" disabled={!history.canRedo} onClick={history.redo} aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)">
              <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 5l3.5 3.5L13 12" />
                <path d="M16.5 8.5h-8a5 5 0 0 0 0 10H12" />
              </svg>
            </button>
          </div>
        )}
        <p className="flow-help">
          Click or drag a step onto the canvas. Drag from the dot on a step's right edge to connect it to the next one. Select a step
          or connection and press Delete to remove it.
        </p>
      </aside>

      <div className="flow-main">
        {notice && <div className="notice">{notice}</div>}
        {canvas}
        {selectedEdge && (
          <button
            type="button"
            className="link-danger flow-remove-edge"
            onClick={() => {
              setFlow({ ...flow, edges: flow.edges.filter((e) => e.id !== selectedEdge) });
              setSelectedEdge(null);
            }}
          >
            Remove the selected connection
          </button>
        )}
      </div>

      <aside className="flow-inspector">
        {!selected ? (
          <>
            <h3>How the flow runs</h3>
            <p className="flow-help">
              altship runs the flow as drawn. A coordinator is given one step at a time: it hands work to each agent and calls
              tool steps itself, and each step is checked before the next starts. Routers are decided by altship and can only
              take a route drawn here. Select a step to edit it.
            </p>
            <label>
              Coordinator model
              <select value={flow.runner.model} onChange={(e) => setFlow({ ...flow, runner: { ...flow.runner, model: e.target.value as AgentModel } })}>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Extra guidance for the coordinator
              <textarea
                rows={6}
                value={flow.runner.instructions}
                onChange={(e) => setFlow({ ...flow, runner: { ...flow.runner, instructions: e.target.value } })}
                placeholder="Optional. e.g. Always answer in English; stop and ask if the request is unclear."
              />
            </label>
          </>
        ) : (
          <>
            <div className="flow-inspector-head">
              <h3>{TYPE_LABEL[selected.type]} step</h3>
              {selected.type !== "input" && (
                <button type="button" className="link-danger" onClick={() => removeSteps([selected.id])}>
                  Delete step
                </button>
              )}
            </div>

            {selected.type === "input" && <p className="flow-help">Where the user's request enters the flow. Connect it to the first step.</p>}
            {selected.type === "output" && (
              <p className="flow-help">Ends the flow: whatever reaches this step is sent back to the user. A flow can have several.</p>
            )}

            {selected.type === "agent" &&
              agents.get(selected.agentKey ?? "") &&
              renderAgent?.(agents.get(selected.agentKey!)!, (patch) =>
                onChange?.({ ...plan, agents: plan.agents.map((a) => (a.key === selected.agentKey ? { ...a, ...patch } : a)) }),
              )}

            {selected.type === "router" && (
              <>
                <label>
                  Name
                  <input value={selected.label ?? ""} maxLength={80} onChange={(e) => updateStep(selected.id, { label: e.target.value })} />
                </label>
                <label>
                  How to choose a route
                  <textarea
                    rows={4}
                    value={selected.rule ?? ""}
                    onChange={(e) => updateStep(selected.id, { rule: e.target.value })}
                    placeholder="e.g. Use the country the request is about."
                  />
                </label>
                <div className="flow-route-list">
                  <span>Routes</span>
                  {(selected.routes ?? []).map((route) => (
                    <div key={route.id} className="flow-route-edit">
                      <input
                        value={route.label}
                        maxLength={200}
                        aria-label="Route"
                        placeholder="When to take this route"
                        onChange={(e) =>
                          updateStep(selected.id, { routes: selected.routes!.map((r) => (r.id === route.id ? { ...r, label: e.target.value } : r)) })
                        }
                      />
                      <button
                        type="button"
                        className="tool-remove"
                        aria-label={`Remove route ${route.label}`}
                        disabled={(selected.routes ?? []).length <= 2}
                        title={(selected.routes ?? []).length <= 2 ? "A router needs at least two routes" : "Remove this route"}
                        onClick={() =>
                          setFlow({
                            ...flow,
                            nodes: flow.nodes.map((n) => (n.id === selected.id ? { ...n, routes: n.routes!.filter((r) => r.id !== route.id) } : n)),
                            edges: flow.edges.filter((e) => !(e.source === selected.id && e.route === route.id)),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      updateStep(selected.id, {
                        routes: [...(selected.routes ?? []), { id: newId("route"), label: `Route ${(selected.routes ?? []).length + 1}` }],
                      })
                    }
                  >
                    + Add route
                  </button>
                </div>
              </>
            )}

            {selected.type === "tool" && (
              <>
                <label>
                  Tool to call
                  <select
                    value={selected.tool ? `mcp:${selected.tool.server}/${selected.tool.tool}` : `builtin:${selected.builtinTool?.tool}`}
                    onChange={(e) => {
                      const patch = toolPatch(e.target.value);
                      if (patch) updateStep(selected.id, patch);
                    }}
                  >
                    {toolOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <ToolPermission step={selected} servers={servers} onChange={(patch) => updateStep(selected.id, patch)} />
                <label>
                  Name (optional)
                  <input
                    value={selected.label ?? ""}
                    maxLength={80}
                    placeholder={toolName(selected)}
                    onChange={(e) => updateStep(selected.id, { label: e.target.value })}
                  />
                </label>
                <p className="flow-help">The coordinator calls this tool itself at this point, building the input from the previous step.</p>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

/** Whether a tool step runs on its own or waits for approval. Destructive tools always ask. */
function ToolPermission({
  step,
  servers,
  onChange,
}: {
  step: FlowNode;
  servers: Map<string, CatalogServer>;
  onChange: (patch: Partial<FlowNode>) => void;
}) {
  const destructive = step.tool ? Boolean(servers.get(step.tool.server)?.tools.find((t) => t.name === step.tool!.tool)?.destructive) : false;
  const permission = step.tool?.permission ?? step.builtinTool?.permission ?? "auto";
  return (
    <label>
      Permission
      <select
        value={destructive ? "ask" : permission}
        disabled={destructive}
        onChange={(e) => {
          const value = e.target.value as "auto" | "ask";
          onChange(step.tool ? { tool: { ...step.tool, permission: value } } : { builtinTool: { ...step.builtinTool!, permission: value } });
        }}
      >
        <option value="auto">Auto: runs without asking</option>
        <option value="ask">Ask: waits for approval each time</option>
      </select>
      {destructive && <small>This tool is destructive, so it always asks.</small>}
    </label>
  );
}
