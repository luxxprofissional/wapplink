# WappLink

<img src="build/logo.png" alt="WappLink" width="220">

Várias contas de WhatsApp Web em uma janela só. Cada conta tem sessão própria
(cookies, IndexedDB, tudo separado), então os números ficam logados ao mesmo
tempo sem um derrubar o outro — e você escolhe quantos aparecem na tela ao
mesmo tempo, em colunas ou em linhas.

## Rodar em modo desenvolvimento

```
npm install
npm start
```

Na primeira abertura cada conta mostra um QR code — leia com o celular
correspondente (WhatsApp > Dispositivos conectados > Conectar dispositivo).
A partir daí a sessão fica salva.

## Gerar o instalador do Windows

```
npm run dist
```

Sai um `.exe` (NSIS) em `dist/`. Instalação por usuário, sem admin.

## Como se organiza a tela

| Ação | Resultado |
| --- | --- |
| Clique numa conta do rail | foca nela (no modo dividido, ela assume o painel em que você estava) |
| **Ctrl+clique** numa conta | põe ou tira essa conta da tela dividida |
| Arrastar a divisória | muda a proporção entre os painéis |
| `Ctrl+Alt+1/2/3` | uma conta / colunas (em pé) / linhas (deitado) |
| `Ctrl+Alt+0` | divide tudo por igual |
| `Ctrl+D` | põe ou tira a conta atual da divisão |

No rail, a barrinha colorida à esquerda mostra o estado: **curta** = a conta
está aparecendo em algum painel, **comprida** = é a conta focada (a que recebe
o teclado).

## Contas e ajustes

A engrenagem no pé do rail (ou `Ctrl+,`) abre uma **janela flutuante** — ela não
empurra nem espreme o WhatsApp, e some sozinha quando perde o foco ou no `Esc`.
Lá dentro dá pra:

- **Foto:** clique no quadradinho da conta e escolha uma imagem. Ela é recortada
  no centro e reduzida pra 128px (`nativeImage`), sem virar dependência nova.
- **Ordem:** arraste as linhas pelo `⠿` — a ordem do rail é a que você definir.
- **Nome e cor**, recarregar, desconectar (apaga a sessão e volta pro QR).
- **Adicionar / remover conta** — até 8. Cada conta é um WhatsApp Web inteiro
  rodando, então o limite é RAM, não código.

## Atalhos

| Atalho | O que faz |
| --- | --- |
| `Ctrl+1` … `Ctrl+9` | foca a conta naquela posição do rail |
| `Ctrl+Tab` | próxima conta |
| `Ctrl+,` | abre/fecha a janela de contas e tela |
| `Ctrl+R` | recarrega a conta focada |
| `Ctrl+Shift+R` | recarrega todas |
| `Ctrl+W` | esconde na bandeja (continua recebendo) |
| `Ctrl+Q` | sai de verdade |
| `Ctrl+ +` `Ctrl+ -` `Ctrl+0` | zoom da conta focada |
| `F12` | DevTools da conta focada |

## Detalhes de implementação

- **Bandeja:** fechar a janela só esconde — o app segue rodando e notificando.
  Dá pra desligar no menu do ícone da bandeja ou na janela de ajustes.
- **Notificações:** clicar na notificação do Windows abre a janela **na conta
  que recebeu a mensagem** (`src/preload-wa.js` faz esse gancho).
- **Não lidas:** o número na aba vem do título da página do WhatsApp.
- **Contas fora da tela** continuam com `backgroundThrottling` desligado, senão
  o Chromium suspenderia os timers e as mensagens chegariam atrasadas.
- **Divisórias:** as views do WhatsApp cobrem a janela inteira, então o mouse
  nunca chega no nosso HTML — exceto na folga de 8px entre os painéis, que é
  justamente onde ficam as alças. Enquanto você arrasta, o `main` sobe uma view
  transparente por cima de tudo (`drag.html`) só pra não perder o ponteiro
  quando ele passa por cima do WhatsApp.
- **Onde ficam os dados:** `%APPDATA%\WappLink` (Mac:
  `~/Library/Application Support/WappLink`) — `config.json`, `avatars/` e as
  sessões em `Partitions/`. Backup dessa pasta = backup dos logins. Quem veio do
  tempo em que o app se chamava ZapBox continua na pasta `ZapBox`, de propósito:
  é lá que estão as sessões.

## Atualização automática

O app procura versão nova 15s depois de abrir e depois a cada 4h, nos Releases
de [luxxprofissional/wapplink](https://github.com/luxxprofissional/wapplink).
Achou: baixa em segundo plano, avisa por notificação e instala quando o usuário
clica em **Reiniciar e atualizar** (menu Arquivo ou bandeja) ou ao sair.

- **Windows:** `electron-updater` sobre o instalador NSIS. Só atualiza quem
  instalou pelo `WappLink-Setup-x.y.z.exe` — rodar direto de `win-unpacked` não
  atualiza.
- **Mac:** o app não é assinado pela Apple e o Squirrel.Mac recusa app sem
  assinatura, então `src/updater.js` faz na mão: lê `latest-mac.yml`, baixa o
  `.zip` da arquitetura, confere o sha512, descompacta com `ditto` e troca o
  `.app` depois que o processo fecha.
- Log em `updater.log`, na pasta de dados.

### Lançar uma versão

1. Suba `"version"` no `package.json` (ex.: `1.1.0` → `1.1.1`).
2. No Windows: `npm run release` — gera o instalador e sobe no rascunho `v1.1.1`.
3. No Mac: `npm run release` — gera os `.zip` e sobe no mesmo rascunho.
4. Em qualquer um: `npm run release:publish` — tira do rascunho e todo mundo
   recebe. Enquanto for rascunho, ninguém vê.

Precisa de `gh auth login` (ou `GH_TOKEN`) na máquina que publica.

## Estrutura

```
src/main.js            processo principal: janelas, sessões, layout, menus, bandeja
src/shell.html         o rail lateral + as alças das divisórias
src/settings.html      janela flutuante de contas e tela
src/drag.html          camada transparente usada durante o arrasto
src/preload-*.js       pontes IPC de cada tela
src/updater.js         atualização automática (Windows e Mac)
build/logo.png         logo completo; os ícones saem dele
tools/make-icon.js     recorta o balão do logo e gera icon.png/.ico/-mac.png (npm run icon)
tools/release.js       sobe o build no GitHub e publica o release
```
