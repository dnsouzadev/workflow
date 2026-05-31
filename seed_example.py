import requests
import json
import sys

API_BASE = "http://localhost:8000"

def seed():
    print("🚀 Iniciando seeding do exemplo completo...")

    # 1. Criar a Secret (Placeholder)
    print("Step 1: Criando secret SLACK_WEBHOOK...")
    requests.post(f"{API_BASE}/secrets", json={
        "name": "SLACK_WEBHOOK",
        "value": "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"
    })

    # 2. Definir o Workflow
    workflow_payload = {
        "nodes": [
            {
                "id": "1",
                "type": "http_request",
                "x": 100, "y": 150,
                "data": {
                    "url": "https://api.github.com/repos/google/gemini-cli",
                    "method": "GET"
                }
            },
            {
                "id": "2",
                "type": "script",
                "x": 400, "y": 150,
                "data": {
                    "code": "stars = data.get('stargazers_count', 0)\nname = data.get('full_name', 'Unknown')\nresult = f'📊 *Relatório Gemini CLI*\\nO repositório {name} atingiu {stars} estrelas!'"
                }
            },
            {
                "id": "3",
                "type": "slack_webhook",
                "x": 700, "y": 150,
                "data": {
                    "webhook_url": "secret:SLACK_WEBHOOK",
                    "text": "{data}"
                }
            }
        ],
        "edges": [
            {"from": "1", "to": "2"},
            {"from": "2", "to": "3"}
        ]
    }

    # 3. Salvar o Workflow
    print("Step 2: Salvando workflow 'Monitoramento GitHub'...")
    res = requests.post(f"{API_BASE}/workflows", json={
        "name": "Monitoramento GitHub",
        "description": "Busca estrelas do GitHub e notifica no Slack a cada 5 min",
        "payload": workflow_payload
    })
    
    if res.status_code != 200:
        print(f"❌ Erro ao salvar workflow: {res.text}")
        return
        
    workflow_id = res.json()["workflow_id"]
    print(f"✅ Workflow criado: {workflow_id}")

    # 4. Criar o Agendamento (Trigger)
    print("Step 3: Criando trigger cron (a cada 5 minutos)...")
    requests.post(f"{API_BASE}/schedules", json={
        "workflow_id": workflow_id,
        "name": "Check GitHub Stars",
        "cron": "*/5 * * * *"
    })

    print("\n✨ Exemplo configurado com sucesso!")
    print(f"1. Vá em 'Secrets' e altere o valor de SLACK_WEBHOOK para o seu URL real.")
    print(f"2. O workflow rodará sozinho a cada 5 minutos.")
    print(f"3. Você pode ver as execuções no 'Dashboard' e inspecionar os logs no 'Run Inspector'.")

if __name__ == "__main__":
    try:
        seed()
    except Exception as e:
        print(f"❌ Erro de conexão: Certifique-se que o backend está rodando em {API_BASE}")
        print(f"Detalhe: {e}")
