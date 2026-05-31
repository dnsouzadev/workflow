import httpx
import json
import logging
import time

logger = logging.getLogger("workflow.node")

NODE_REGISTRY = {}

def register_node(node_type):
    def decorator(func):
        NODE_REGISTRY[node_type] = func
        return func
    return decorator

@register_node("input")
def run_input_node(node_def, data, context=None):
    if context: context.log("Starting input node")
    config = node_def.get("data", {})
    val = data if data is not None else config.get("value", [1, 2, 3, 4, 5])
    if context: context.log(f"Input value resolved: {val}")
    return val

@register_node("filter")
def run_filter_node(node_def, data, context=None):
    config = node_def.get("data", {})
    threshold = config.get("threshold", 2)
    key = config.get("key")
    if context: context.log(f"Filtering with threshold: {threshold}")

    if isinstance(data, list):
        res = [x for x in data if (x > threshold if isinstance(x, (int, float)) else True)]
        if context: context.log(f"Filtered {len(data)} items down to {len(res)}")
        return res
    
    if isinstance(data, dict) and key:
        values = data.get(key)
        if isinstance(values, list):
            filtered = [x for x in values if (x > threshold if isinstance(x, (int, float)) else True)]
            updated = dict(data)
            updated[key] = filtered
            if context: context.log(f"Filtered key '{key}': {len(values)} -> {len(filtered)}")
            return updated
    
    return data

@register_node("http_request")
def run_http_node(node_def, data, context=None):
    config = node_def.get("data", {})
    url = config.get("url")
    method = config.get("method", "GET").upper()
    headers = config.get("headers", {})
    
    if not url:
        raise ValueError("HTTP Request node requires a URL")
    
    if isinstance(data, dict):
        try:
            url = url.format(**data)
        except Exception:
            pass

    if context: context.log(f"Making {method} request to {url}")
    with httpx.Client(timeout=30.0) as client:
        if method == "GET":
            response = client.get(url, headers=headers, params=data if isinstance(data, dict) else None)
        else:
            response = client.request(method, url, headers=headers, json=data)
        
        if context: context.log(f"Response status: {response.status_code}")
        response.raise_for_status()
        try:
            return response.json()
        except Exception:
            return response.text

@register_node("json_transform")
def run_transform_node(node_def, data, context=None):
    config = node_def.get("data", {})
    template = config.get("template")
    
    if not template:
        return data
        
    if isinstance(data, dict):
        try:
            if context: context.log("Applying transformation template")
            if isinstance(template, str) and (template.startswith("{") or template.startswith("[")):
                rendered = template.format(**data)
                return json.loads(rendered)
            elif isinstance(template, dict):
                return json.loads(json.dumps(template).format(**data))
        except Exception as e:
            if context: context.log(f"Transformation error: {e}")
            logger.warning(f"Transformation failed: {e}")
    
    return data

@register_node("script")
def run_script_node(node_def, data, context=None):
    config = node_def.get("data", {})
    code = config.get("code", "result = data")
    
    if context: context.log("Executing Python script")
    local_vars = {"data": data, "result": None, "json": json, "log": context.log if context else print}
    try:
        exec(code, {}, local_vars)
        return local_vars.get("result")
    except Exception as e:
        if context: context.log(f"Script error: {e}")
        raise RuntimeError(f"Script execution failed: {e}")

@register_node("output")
def run_output_node(node_def, data, context=None):
    if context: context.log(f"Output received: {data}")
    print(f"NODE {node_def['id']} OUTPUT:", data)
    return data

@register_node("condition")
def run_condition_node(node_def, data, context=None):
    config = node_def.get("data", {})
    expression = config.get("expression")
    
    if not expression:
        if context: context.log("No expression provided for condition")
        return {"result": True, "reason": "No expression provided"}
        
    local_vars = {"data": data, "json": json}
    try:
        if context: context.log(f"Evaluating condition: {expression}")
        result = eval(expression, {}, local_vars)
        if context: context.log(f"Condition result: {result}")
        return {"result": bool(result), "expression": expression}
    except Exception as e:
        if context: context.log(f"Condition error: {e}")
        raise RuntimeError(f"Condition evaluation failed: {e}")

@register_node("delay")
def run_delay_node(node_def, data, context=None):
    config = node_def.get("data", {})
    seconds = config.get("seconds", 1)
    if context: context.log(f"Delaying for {seconds} seconds")
    time.sleep(seconds)
    return data

def resolve_config_value(value, storage, context=None):
    if isinstance(value, str) and value.startswith("secret:"):
        secret_name = value.replace("secret:", "")
        if context: context.log(f"Resolving secret: {secret_name}")
        return storage.get_secret(secret_name)
    return value

@register_node("slack_webhook")
def run_slack_node(node_def, data, context=None):
    config = node_def.get("data", {})
    # Get storage from engine if possible, otherwise skip secret resolution
    # In a real refactor, we should pass storage or a resolver to run_node
    # For now, let's assume we can access it via a global or pass it in context
    storage = getattr(context, 'storage', None)
    
    webhook_url = resolve_config_value(config.get("webhook_url"), storage, context)
    text = config.get("text", "Workflow Notification")
    
    if not webhook_url:
        raise ValueError("Slack node requires a webhook_url")
        
    if isinstance(data, dict):
        try:
            text = text.format(**data)
        except Exception:
            pass
            
    if context: context.log(f"Sending Slack notification...")
    with httpx.Client(timeout=10.0) as client:
        res = client.post(webhook_url, json={"text": text})
        res.raise_for_status()
        if context: context.log("Slack notification sent successfully")
        return {"status": "sent"}

@register_node("discord_webhook")
def run_discord_node(node_def, data, context=None):
    config = node_def.get("data", {})
    storage = getattr(context, 'storage', None)
    
    webhook_url = resolve_config_value(config.get("webhook_url"), storage, context)
    content = config.get("content", "Workflow Notification")
    
    if not webhook_url:
        raise ValueError("Discord node requires a webhook_url")
        
    if isinstance(data, dict):
        try:
            content = content.format(**data)
        except Exception:
            pass
            
    if context: context.log(f"Sending Discord notification...")
    with httpx.Client(timeout=10.0) as client:
        res = client.post(webhook_url, json={"content": content})
        res.raise_for_status()
        if context: context.log("Discord notification sent successfully")
        return {"status": "sent"}

def run_node(node_def, data, context=None):
    node_type = node_def.get("type")
    handler = NODE_REGISTRY.get(node_type)
    
    if not handler:
        if context is not None:
            context.log(f"No handler for node type: {node_type}")
        return data
        
    return handler(node_def, data)
