import os
import requests
from flask import Flask

TOKEN = os.environ.get("TOKEN")
CHAT_ID = os.environ.get("CHAT_ID")

app = Flask(__name__)

def send_message(text):
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    payload = {"chat_id": CHAT_ID, "text": text}
    requests.post(url, data=payload)

@app.route("/")
def home():
    send_message("🔔 Teste de integração: seu bot está ativo e pronto para enviar entradas Premium durante Londres e NY.")
    return "Mensagem enviada!"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
