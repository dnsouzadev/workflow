from collections import defaultdict

def build_graph(edges):
    graph = defaultdict(list)

    for edge in edges:
        graph[edge["from"]].append(edge["to"])

    return graph


def build_node_map(nodes):
    node_map = {}
    for node in nodes:
        node_id = node["id"]
        if node_id in node_map:
            raise ValueError(f"Duplicate node id: {node_id}")
        node_map[node_id] = node
    return node_map


def build_dependency_maps(nodes, edges):
    node_ids = [node["id"] for node in nodes]
    node_set = set(node_ids)

    if len(node_set) != len(node_ids):
        raise ValueError("Duplicate node ids detected")

    children = {node_id: [] for node_id in node_ids}
    parents = {node_id: [] for node_id in node_ids}

    for edge in edges:
        from_id = edge["from"]
        to_id = edge["to"]

        if from_id not in node_set:
            raise ValueError(f"Edge references unknown node: {from_id}")
        if to_id not in node_set:
            raise ValueError(f"Edge references unknown node: {to_id}")

        children[from_id].append(to_id)
        parents[to_id].append(from_id)

    indegree = {node_id: len(parents[node_id]) for node_id in node_ids}

    return children, parents, indegree
