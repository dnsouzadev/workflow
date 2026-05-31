import { useMemo, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";
import { NodeStatus, WorkflowEdge, WorkflowNode } from "../workflow";

type GraphProps = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  nodeStatus: Record<string, NodeStatus>;
  connectMode: boolean;
  selectedNodeId: string | null;
  onNodePositionChange: (nodeId: string, x: number, y: number) => void;
  onCreateEdge: (from: string, to: string) => void;
  onDropNode: (nodeType: string, x: number, y: number) => void;
  onSelectNode: (nodeId: string | null) => void;
};

type DragState = {
  nodeId: string;
  offsetX: number;
  offsetY: number;
};

type LinkState = {
  fromId: string;
  toX: number;
  toY: number;
};

const statusColor = (status: NodeStatus) => {
  switch (status) {
    case "running":
      return "#f59e0b";
    case "success":
      return "#22c55e";
    case "error":
      return "#ef4444";
    case "skipped":
      return "#94a3b8";
    default:
      return "#4f46e5";
  }
};

export default function Graph({
  nodes,
  edges,
  nodeStatus,
  connectMode,
  selectedNodeId,
  onNodePositionChange,
  onCreateEdge,
  onDropNode,
  onSelectNode
}: GraphProps) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [linkState, setLinkState] = useState<LinkState | null>(null);

  const nodeLookup = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    nodes.forEach((node) => {
      map.set(node.id, node);
    });
    return map;
  }, [nodes]);

  const getPoint = (event: { clientX: number; clientY: number }) => {
    if (!ref.current) return { x: 0, y: 0 };
    const svg = ref.current;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const transformed = point.matrixTransform(ctm.inverse());
    return {
      x: transformed.x,
      y: transformed.y
    };
  };

  const handleMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    if (dragState) {
      const point = getPoint(event);
      onNodePositionChange(
        dragState.nodeId,
        point.x - dragState.offsetX,
        point.y - dragState.offsetY
      );
    }

    if (linkState) {
      const point = getPoint(event);
      setLinkState({
        fromId: linkState.fromId,
        toX: point.x,
        toY: point.y
      });
    }
  };

  const handleMouseUp = () => {
    if (dragState) {
      setDragState(null);
    }
    if (linkState) {
      setLinkState(null);
    }
  };

  const handleNodeMouseDown = (
    event: MouseEvent<SVGGElement>,
    node: WorkflowNode
  ) => {
    event.stopPropagation();
    onSelectNode(node.id);
    if (connectMode) {
      const point = getPoint(event);
      setLinkState({
        fromId: node.id,
        toX: point.x,
        toY: point.y
      });
      return;
    }

    const point = getPoint(event);
    setDragState({
      nodeId: node.id,
      offsetX: point.x - (node.x ?? 0),
      offsetY: point.y - (node.y ?? 0)
    });
  };

  const handleNodeMouseUp = (
    event: MouseEvent<SVGGElement>,
    node: WorkflowNode
  ) => {
    event.stopPropagation();
    if (!connectMode || !linkState) return;
    if (linkState.fromId !== node.id) {
      onCreateEdge(linkState.fromId, node.id);
    }
    setLinkState(null);
  };

  const handleDragOver = (event: DragEvent<SVGSVGElement>) => {
    event.preventDefault();
  };

  const handleDrop = (event: DragEvent<SVGSVGElement>) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData("application/node-type");
    if (!nodeType) return;
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    onDropNode(nodeType, x, y);
  };

  const handleCanvasMouseDown = (event: MouseEvent<SVGSVGElement>) => {
    const target = event.target as SVGElement | null;
    if (target && (target.id === "grid-rect" || target === ref.current)) {
      onSelectNode(null);
    }
  };

  const viewBoxWidth = 1000;
  const viewBoxHeight = 600;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ cursor: connectMode ? "crosshair" : "default" }}
    >
      <defs>
        <pattern
          id="grid"
          width="28"
          height="28"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 28 0 L 0 0 0 28"
            fill="none"
            stroke="#1f2937"
            strokeWidth="1"
          />
        </pattern>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
        </marker>
        <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow
            dx="0"
            dy="3"
            stdDeviation="3"
            floodColor="#020617"
            floodOpacity="0.5"
          />
        </filter>
      </defs>

      <rect
        id="grid-rect"
        width="100%"
        height="100%"
        fill="url(#grid)"
      />

      <g stroke="#475569" strokeWidth={2} strokeOpacity={0.7}>
        {edges.map((edge) => {
          const from = nodeLookup.get(edge.from);
          const to = nodeLookup.get(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={from.x ?? 0}
              y1={from.y ?? 0}
              x2={to.x ?? 0}
              y2={to.y ?? 0}
              markerEnd="url(#arrow)"
            />
          );
        })}
      </g>

      {linkState ? (
        <line
          x1={nodeLookup.get(linkState.fromId)?.x ?? 0}
          y1={nodeLookup.get(linkState.fromId)?.y ?? 0}
          x2={linkState.toX}
          y2={linkState.toY}
          stroke="#38bdf8"
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      ) : null}

      {nodes.map((node) => (
        <g
          key={node.id}
          onMouseDown={(event) => handleNodeMouseDown(event, node)}
          onMouseUp={(event) => handleNodeMouseUp(event, node)}
          style={{ cursor: connectMode ? "crosshair" : "grab" }}
        >
          {selectedNodeId === node.id ? (
            <circle
              cx={node.x ?? 0}
              cy={node.y ?? 0}
              r={28}
              fill="none"
              stroke="#38bdf8"
              strokeWidth={2}
            />
          ) : null}
          <circle
            cx={node.x ?? 0}
            cy={node.y ?? 0}
            r={22}
            fill={statusColor(nodeStatus[node.id] ?? "idle")}
            stroke="#fff"
            strokeWidth={2}
            filter="url(#shadow)"
          />
          <text
            x={node.x ?? 0}
            y={node.y ?? 0}
            fontSize={12}
            fill="#fff"
            textAnchor="middle"
            dy={4}
          >
            {node.id}
          </text>
          <text
            x={node.x ?? 0}
            y={(node.y ?? 0) + 20}
            fontSize={10}
            fill="#cbd5f5"
            textAnchor="middle"
          >
            {node.type}
          </text>
        </g>
      ))}
    </svg>
  );
}
