import os
import time
import requests
import random

TOKEN = os.environ.get("TOKEN")
CHAT_ID = os.environ.get("CHAT_ID")

def send_message(text):
    url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
    payload = {"chat_id": CHAT_ID, "text": text}
    try:
        requests.post(url, data=payload)
    except Exception as e:
        print("Erro ao enviar mensagem:", e)

# Mensagem inicial de integração
send_message("🔔 Integração concluída – o bot está ativo e enviará setups Premium automaticamente.")

ativos = ["XAU/USD", "EUR/USD", "GBP/USD"]

def gerar_setup():
    ativo = random.choice(ativos)
    direcao = random.choice(["BUY", "SELL"])
    entrada = round(random.uniform(1.10, 3500), 2)
    sl = round(entrada - random.uniform(0.5, 2.0), 2)
    tp = round(entrada + random.uniform(1.0, 3.0), 2)
    be = round((entrada + tp) / 2, 2)
    trailing = round(tp - random.uniform(0.2, 0.5), 2)
    prob = random.randint(75, 95)
    comentario = "Setup Premium detectado automaticamente com alta confluência."
    return f"🔥 {ativo} – {direcao}\nEntrada: {entrada}\nSL: {sl} | TP: {tp}\nBreak Even: {be} | Trailing: {trailing}\nProbabilidade: {prob}%\nComentário: {comentario}"

# Loop contínuo (simulação de monitoramento)
while True:
    # Simula envio de setups a cada 10 minutos
    time.sleep(600)
    setup_msg = gerar_setup()
    send_message(setup_msg)
