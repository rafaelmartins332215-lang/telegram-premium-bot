# Scanner Ouro V10.9 (Google Apps Script)

Scanner de Over gols que manda alertas **simulados** no Telegram. Não aposta
sozinho. As probabilidades são experimentais e recalibradas automaticamente
depois que os resultados são conferidos.

## Instalação (uma vez)

1. Em [script.google.com](https://script.google.com), crie um projeto e cole
   `Code.gs` inteiro.
2. **Configurações do projeto → Propriedades do script**, adicione:

   | Propriedade | Valor |
   |---|---|
   | `OURO_API_KEY` | chave da API-Football |
   | `OURO_TELEGRAM_TOKEN` | token do bot (@BotFather) |
   | `OURO_TELEGRAM_CHAT_ID` | chat que recebe os alertas |

3. Rode `testarConexoes()` para confirmar API e Telegram.
4. Rode `instalarScannerOver()`. Ela cria os acionadores:
   varredura a cada 5 min, conferência a cada 10 min e fechamento diário a cada hora.

Depois disso não há nada para fazer: sinais, conferência, auditoria,
calibração, CLV e arquivamento no Drive rodam sozinhos.

## Ajustes opcionais (no objeto `OURO`)

- `CASAS`: casas aceitas no pré-jogo, por exemplo `['Bet365', 'Betano']`.
  Vazio aceita todas.
- `ODD_ESCOLHA`: `'MEDIANA'` (padrão, preço realista) ou `'MAIOR'`
  (melhor odd do mercado; infla o EV).

## Funções úteis

- `diagnosticoScanner()`: motivos da última varredura.
- `verAprendizadoScanner()` / `verSensibilidadePressao()`: estado da calibração.
- `verAuditoriaDoDia('2026-09-27')`: relatório de um dia.
- `resumoResultados()`: placar geral de greens e reds.
- `pararScanner()`: remove os acionadores.

## Testes

```
node apps-script/tests/run.js
```

Simulam o Apps Script, a API-Football e o Telegram em memória. Também rodam
no GitHub Actions a cada push.
