# Scanner Cripto V1 (Google Apps Script)

Robô de sinais da estratégia validada em `backtest/`: rompimento com volume em
4h, só compra, com filtro do BTC acima da EMA200 diária. **Modo simulado**:
manda os sinais no Telegram e acompanha o resultado numa banca simulada. Não
envia ordens para a corretora.

Roda num projeto **separado** do Scanner Ouro. Funções, propriedades e
acionadores têm prefixo `cripto` e não tocam nos do Ouro.

## Instalação

1. Em [script.google.com](https://script.google.com), clique em **Novo projeto**
   (não abra o projeto do Ouro). Dê o nome "Scanner Cripto".
2. Apague o conteúdo de `Código.gs` e cole `Code.gs` inteiro.
3. **Configurações do projeto → Propriedades do script**:

   | Propriedade | Valor |
   |---|---|
   | `CRIPTO_TELEGRAM_TOKEN` | token do bot (pode ser o mesmo do Ouro ou um bot novo) |
   | `CRIPTO_TELEGRAM_CHAT_ID` | chat que recebe os alertas |
   | `CRIPTO_BANCA` | (opcional) banca inicial em dólares, padrão `50` |

4. Rode `testarConexoesCripto()` e autorize o acesso.
5. Rode `instalarScannerCripto()`.

## Funções úteis

- `resumoCripto()`: banca, acerto e posições abertas.
- `diagnosticoCripto()`: o que aconteceu na última varredura.
- `pararScannerCripto()`: remove só os acionadores deste robô.
- `zerarSimulacaoCripto()`: recomeça a banca simulada.

## Testes

`node apps-script-cripto/tests/run.js`
