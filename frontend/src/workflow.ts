export type WorkflowNode = {
  id: string;
  type?: string;
  x?: number;
  y?: number;
  data?: any;
};

export type WorkflowEdge = {
  from: string;
  to: string;
};

export type Workflow = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export type NodeStatus = "idle" | "running" | "success" | "error" | "skipped";

export const workflow: Workflow = {
  nodes: [
    { id: "1", type: "input", x: 200, y: 180 },
    { id: "2", type: "filter", x: 500, y: 180 },
    { id: "3", type: "output", x: 800, y: 180 }
  ],
  edges: [
    { from: "1", to: "2" },
    { from: "2", to: "3" }
  ]
};
