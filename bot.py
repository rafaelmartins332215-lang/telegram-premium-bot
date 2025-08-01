import os
import time
import requests

# Pega as variáveis de ambiente do Render
TOKEN = os.environ.get("TOKEN")
CHAT_ID = os.environ.get("CHAT_ID")

# Função para enviar mensagens no Telegram
def send_message(text):
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    payload = {"chat_id": CHAT_ID, "text": text}
    try:
        requests.post(url, data=payload)
    except Exception as e:
        print("Erro ao enviar mensagem:", e)

# Envia mensagem de integração
send_message("🔔 Bot mínimo iniciado com sucesso no Render!")

# Mantém o bot ativo para não encerrar
while True:
    time.sleep(60)
