import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PipelineEdge, PipelineNode, PipelineSpec } from '../../../shared/ipc-contract';
import { useStore } from '../state/store';

/**
 * The pipeline editor: draw a reusable multi-agent workflow as tiles wired
 * together — agent steps and reviewer gates whose pass/fail verdict branches the
 * flow (loops allowed). Saved to config.pipelines. Running a pipeline, invoking
 * it from chat, and picking it at Scaffold are follow-ups; this is the editor.
 */

type StepData = { kind: 'agent' | 'reviewer'; agentId: string; label: string; task: string };

interface AgentOpt {
  id: string;
  name: string;
}
const AgentsCtx = createContext<AgentOpt[]>([]);

function AgentSelect({ id, value }: { id: string; value: string }) {
  const agents = useContext(AgentsCtx);
  const { updateNodeData } = useReactFlow();
  return (
    <select
      className="nodrag"
      value={value}
      onChange={(e) => updateNodeData(id, { agentId: e.target.value })}
    >
      <option value="">(any — best fit)</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

function AgentNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as StepData;
  const { updateNodeData } = useReactFlow();
  return (
    <div className={`pl-node pl-node--agent${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="pl-node-kind">agent</div>
      <AgentSelect id={id} value={d.agentId} />
      <input
        className="nodrag"
        placeholder="role / label"
        value={d.label}
        onChange={(e) => updateNodeData(id, { label: e.target.value })}
      />
      <textarea
        className="nodrag"
        placeholder="what this step does…"
        rows={2}
        value={d.task}
        onChange={(e) => updateNodeData(id, { task: e.target.value })}
      />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function ReviewerNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as StepData;
  const { updateNodeData } = useReactFlow();
  return (
    <div className={`pl-node pl-node--reviewer${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="pl-node-kind">reviewer · gate</div>
      <AgentSelect id={id} value={d.agentId} />
      <input
        className="nodrag"
        placeholder="what to check for…"
        value={d.label}
        onChange={(e) => updateNodeData(id, { label: e.target.value })}
      />
      <div className="pl-ports">
        <span className="pl-port pl-port--pass">pass ↓</span>
        <span className="pl-port pl-port--fail">fail ↓</span>
      </div>
      <Handle id="pass" type="source" position={Position.Bottom} style={{ left: '28%' }} />
      <Handle id="fail" type="source" position={Position.Bottom} style={{ left: '72%' }} />
    </div>
  );
}

const nodeTypes = { agent: AgentNode, reviewer: ReviewerNode };

const toFlowNode = (n: PipelineNode): Node => ({
  id: n.id,
  type: n.kind,
  position: { x: n.x, y: n.y },
  data: { kind: n.kind, agentId: n.agentId ?? '', label: n.label ?? '', task: n.task ?? '' },
});
const toFlowEdge = (e: PipelineEdge): Edge => ({
  id: e.id,
  source: e.source,
  target: e.target,
  sourceHandle: e.branch ?? null,
  label: e.branch,
  animated: e.branch === 'fail',
});
const toSpecNode = (n: Node): PipelineNode => {
  const d = n.data as unknown as StepData;
  return {
    id: n.id,
    kind: n.type === 'reviewer' ? 'reviewer' : 'agent',
    agentId: d.agentId || undefined,
    label: d.label || undefined,
    task: d.task || undefined,
    x: Math.round(n.position.x),
    y: Math.round(n.position.y),
  };
};
const toSpecEdge = (e: Edge): PipelineEdge => ({
  id: e.id,
  source: e.source,
  target: e.target,
  branch: e.sourceHandle === 'pass' || e.sourceHandle === 'fail' ? e.sourceHandle : undefined,
});

function PipelinesEditor() {
  const config = useStore((s) => s.config);
  const saveConfig = useStore((s) => s.saveConfig);
  const pipelines = useMemo(() => config?.pipelines ?? [], [config]);
  const agentOptions = useMemo<AgentOpt[]>(
    () => [
      { id: 'default', name: 'Vodo / foreman' },
      ...(config?.agents ?? []).map((a) => ({ id: a.id, name: a.name })),
    ],
    [config],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [foreman, setForeman] = useState('');

  const onConnect = useCallback(
    (c: Connection) => setEdges((es) => addEdge({ ...c, label: c.sourceHandle ?? undefined }, es)),
    [setEdges],
  );

  const addStep = (kind: 'agent' | 'reviewer') => {
    const id = crypto.randomUUID();
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: kind,
        position: { x: 120 + (ns.length % 4) * 60, y: 90 + ns.length * 40 },
        data: { kind, agentId: '', label: '', task: '' },
      },
    ]);
  };

  const loadPipeline = (p: PipelineSpec) => {
    setCurrentId(p.id);
    setName(p.name);
    setForeman(p.foremanAgentId ?? '');
    setNodes(p.nodes.map(toFlowNode));
    setEdges(p.edges.map(toFlowEdge));
  };

  const newPipeline = () => {
    setCurrentId(null);
    setName('');
    setForeman('');
    setNodes([]);
    setEdges([]);
  };

  const save = () => {
    const now = Date.now();
    const id = currentId ?? crypto.randomUUID();
    const existing = pipelines.find((p) => p.id === id);
    const spec: PipelineSpec = {
      id,
      name: name.trim() || 'Untitled pipeline',
      foremanAgentId: foreman || undefined,
      nodes: nodes.map(toSpecNode),
      edges: edges.map(toSpecEdge),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    void saveConfig({ pipelines: [...pipelines.filter((p) => p.id !== id), spec] });
    setCurrentId(id);
  };

  const remove = () => {
    if (!currentId) return;
    void saveConfig({ pipelines: pipelines.filter((p) => p.id !== currentId) });
    newPipeline();
  };

  return (
    <div className="pipelines">
      <div className="pl-topbar">
        <input
          className="pl-name"
          placeholder="Pipeline name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="pl-foreman">
          foreman
          <select value={foreman} onChange={(e) => setForeman(e.target.value)}>
            <option value="">Vodo (default)</option>
            {(config?.agents ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <span className="grow" />
        <button className="ghost" onClick={() => addStep('agent')}>
          + Agent
        </button>
        <button className="ghost" onClick={() => addStep('reviewer')}>
          + Reviewer
        </button>
        <button onClick={save}>Save</button>
        {currentId && (
          <button className="ghost" onClick={remove}>
            Delete
          </button>
        )}
      </div>

      <div className="pl-body">
        <aside className="pl-list">
          <div className="pl-list-head">
            <strong>Saved pipelines</strong>
            <button className="ghost" onClick={newPipeline}>
              + New
            </button>
          </div>
          {pipelines.length === 0 && <p className="hint">None yet — draw one and Save.</p>}
          {pipelines.map((p) => (
            <button
              key={p.id}
              className={`pl-list-item${p.id === currentId ? ' active' : ''}`}
              onClick={() => loadPipeline(p)}
            >
              <span className="pl-list-name">{p.name}</span>
              <span className="meta">{p.nodes.length} steps</span>
            </button>
          ))}
        </aside>

        <div className="pl-canvas">
          <AgentsCtx.Provider value={agentOptions}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={18} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </AgentsCtx.Provider>
          {nodes.length === 0 && (
            <div className="pl-empty">
              <p>
                Add agent tiles and a reviewer gate, then wire them — drag from a tile's bottom dot
                to another's top. Loops are allowed: send a reviewer's <em>fail</em> back to an
                earlier step, <em>pass</em> onward.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Pipelines() {
  return (
    <ReactFlowProvider>
      <PipelinesEditor />
    </ReactFlowProvider>
  );
}
