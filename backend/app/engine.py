import heapq
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED

from helpers import build_dependency_maps, build_node_map
from node import run_node
from storage import utc_now


class NodeExecutionError(Exception):
    def __init__(self, node_id, original_error):
        super().__init__(f"Node {node_id} failed: {original_error}")
        self.node_id = node_id
        self.original_error = original_error

class NodeContext:
    def __init__(self, storage=None):
        self.logs = []
        self.storage = storage
    
    def log(self, message):
        timestamp = utc_now()
        self.logs.append(f"[{timestamp}] {message}")

class WorkflowEngine:
    def __init__(
        self,
        storage,
        default_max_workers=1,
        default_timeout_ms=None,
        default_retries=0,
        retry_backoff_ms=200,
    ):
        self.storage = storage
        self.default_max_workers = default_max_workers
        self.default_timeout_ms = default_timeout_ms
        self.default_retries = default_retries
        self.retry_backoff_ms = retry_backoff_ms

    def execute_workflow(self, workflow, event_handler=None):
        nodes = workflow.get("nodes", [])
        edges = workflow.get("edges", [])
        config = workflow.get("config", {})

        if not nodes:
            raise ValueError("Workflow must contain at least one node")

        node_map = build_node_map(nodes)
        node_ids = [node["id"] for node in nodes]
        node_index = {node_id: idx for idx, node_id in enumerate(node_ids)}

        children, parents, indegree = build_dependency_maps(nodes, edges)
        topological_order = self._topological_sort(
            node_ids, node_index, children, indegree
        )

        max_workers = config.get("max_workers", self.default_max_workers)
        default_timeout_ms = config.get("default_timeout_ms", self.default_timeout_ms)
        default_retries = config.get("default_retries", self.default_retries)
        retry_backoff_ms = config.get("retry_backoff_ms", self.retry_backoff_ms)

        run_id = self.storage.create_run()
        outputs = {}
        node_status = {node_id: "pending" for node_id in node_ids}
        run_error = None
        halt_scheduling = False

        indegree_left = dict(indegree)
        ready = []
        for node_id in topological_order:
            if indegree_left[node_id] == 0:
                heapq.heappush(ready, (node_index[node_id], node_id))

        in_flight = {}

        try:
            self._emit(event_handler, {"type": "run_started", "run_id": run_id})
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                while ready or in_flight:
                    while ready and len(in_flight) < max_workers and not halt_scheduling:
                        _, node_id = heapq.heappop(ready)
                        input_data = self._build_input_data(node_id, parents, outputs)
                        node_status[node_id] = "running"
                        future = executor.submit(
                            self._execute_node,
                            run_id,
                            node_id,
                            node_map[node_id],
                            input_data,
                            default_timeout_ms,
                            default_retries,
                            retry_backoff_ms,
                            event_handler,
                        )
                        in_flight[future] = node_id

                    if not in_flight:
                        break

                    done, _ = wait(in_flight.keys(), return_when=FIRST_COMPLETED)
                    for future in done:
                        node_id = in_flight.pop(future)
                        try:
                            result, logs = future.result()
                        except Exception as err:
                            node_status[node_id] = "failed"
                            run_error = str(err)
                            halt_scheduling = True
                            ready.clear()
                            break

                        outputs[node_id] = result
                        node_status[node_id] = "success"

                        # Branching logic: if node type is 'condition' and result is False, skip children
                        should_skip_children = False
                        if node_map[node_id].get("type") == "condition" and isinstance(result, dict) and result.get("result") is False:
                            should_skip_children = True

                        if not halt_scheduling:
                            for child in children[node_id]:
                                if node_status[child] != "pending":
                                    continue
                                if should_skip_children:
                                    self._mark_branch_skipped(child, children, node_status, run_id, event_handler)
                                else:
                                    indegree_left[child] -= 1
                                    if indegree_left[child] == 0:
                                        heapq.heappush(ready, (node_index[child], child))

                    if run_error and not in_flight:
                        break

        finally:
            skipped_nodes = []
            for pending_id in node_ids:
                if node_status[pending_id] == "pending":
                    node_status[pending_id] = "skipped"
                    self.storage.record_node_skipped(run_id, pending_id)
                    skipped_nodes.append(pending_id)
            status = "failed" if run_error else "success"
            self.storage.finish_run(run_id, status, run_error)
            for pending_id in skipped_nodes:
                self._emit(
                    event_handler,
                    {"type": "node_skipped", "run_id": run_id, "node_id": pending_id},
                )

        final_output = self._resolve_final_output(node_ids, children, outputs)

        self._emit(
            event_handler,
            {
                "type": "run_finished",
                "run_id": run_id,
                "status": "failed" if run_error else "success",
                "result": final_output,
                "all_outputs": outputs,
                "node_status": node_status,
                "error": run_error,
            },
        )

        return {
            "run_id": run_id,
            "status": "failed" if run_error else "success",
            "result": final_output,
            "all_outputs": outputs,
            "node_status": node_status,
        }

    def _topological_sort(self, node_ids, node_index, children, indegree):
        indegree_copy = dict(indegree)
        heap = []
        for node_id in node_ids:
            if indegree_copy[node_id] == 0:
                heapq.heappush(heap, (node_index[node_id], node_id))

        order = []
        while heap:
            _, node_id = heapq.heappop(heap)
            order.append(node_id)
            for child in children[node_id]:
                indegree_copy[child] -= 1
                if indegree_copy[child] == 0:
                    heapq.heappush(heap, (node_index[child], child))

        if len(order) != len(node_ids):
            raise ValueError("Workflow contains a cycle")

        return order

    def _build_input_data(self, node_id, parents, outputs):
        parent_ids = parents[node_id]
        if not parent_ids:
            return None
        if len(parent_ids) == 1:
            return outputs[parent_ids[0]]
        return {parent_id: outputs[parent_id] for parent_id in parent_ids}

    def _execute_node(
        self,
        run_id,
        node_id,
        node_def,
        input_data,
        default_timeout_ms,
        default_retries,
        retry_backoff_ms,
        event_handler,
    ):
        timeout_ms = node_def.get("timeout_ms", default_timeout_ms)
        retries = node_def.get("retries", default_retries)
        effective_input = (
            input_data if input_data is not None else node_def.get("payload")
        )

        attempt = 0
        while attempt <= retries:
            attempt += 1
            started_at = utc_now()
            context = NodeContext(storage=self.storage)
            self._emit(
                event_handler,
                {
                    "type": "node_started",
                    "run_id": run_id,
                    "node_id": node_id,
                    "attempt": attempt,
                },
            )
            try:
                result = self._run_with_timeout(node_def, effective_input, timeout_ms, context)
            except Exception as err:
                finished_at = utc_now()
                logs_str = "\n".join(context.logs)
                self.storage.record_node_attempt(
                    run_id=run_id,
                    node_id=node_id,
                    attempt=attempt,
                    status="failed",
                    started_at=started_at,
                    finished_at=finished_at,
                    output=None,
                    error=str(err),
                    logs=logs_str
                )
                self._emit(
                    event_handler,
                    {
                        "type": "node_failed",
                        "run_id": run_id,
                        "node_id": node_id,
                        "attempt": attempt,
                        "error": str(err),
                        "logs": logs_str,
                        "will_retry": attempt <= retries,
                    },
                )

                if attempt <= retries:
                    time.sleep(retry_backoff_ms / 1000)
                    continue

                raise NodeExecutionError(node_id, err) from err

            finished_at = utc_now()
            logs_str = "\n".join(context.logs)
            self.storage.record_node_attempt(
                run_id=run_id,
                node_id=node_id,
                attempt=attempt,
                status="success",
                started_at=started_at,
                finished_at=finished_at,
                output=result,
                error=None,
                logs=logs_str
            )
            self._emit(
                event_handler,
                {
                    "type": "node_succeeded",
                    "run_id": run_id,
                    "node_id": node_id,
                    "attempt": attempt,
                    "output": result,
                    "logs": logs_str
                },
            )
            return result, context.logs

    def _run_with_timeout(self, node_def, input_data, timeout_ms, context):
        if timeout_ms is None:
            return run_node(node_def, input_data, context)

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(run_node, node_def, input_data, context)
            return future.result(timeout=timeout_ms / 1000)

    def _mark_branch_skipped(self, node_id, children, node_status, run_id, event_handler):
        if node_status[node_id] != "pending":
            return
        node_status[node_id] = "skipped"
        self.storage.record_node_skipped(run_id, node_id)
        self._emit(
            event_handler,
            {"type": "node_skipped", "run_id": run_id, "node_id": node_id},
        )
        for child in children[node_id]:
            self._mark_branch_skipped(child, children, node_status, run_id, event_handler)

    def _resolve_final_output(self, node_ids, children, outputs):
        sinks = [node_id for node_id in node_ids if not children[node_id]]
        if not sinks:
            return None
        if len(sinks) == 1:
            return outputs.get(sinks[0])
        return {node_id: outputs.get(node_id) for node_id in sinks}

    def _emit(self, event_handler, event):
        if event_handler is None:
            return
        if "timestamp" not in event:
            event["timestamp"] = utc_now()
        event_handler(event)
