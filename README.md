# Antigravity Browser (Inspector) 🌐

Extensão embutida para o **Google Antigravity IDE** que traz um navegador web com seletor interativo de elementos DOM (idêntico ao recurso Browser Tab do Cursor), permitindo inspecionar qualquer componente visual da sua aplicação local e injetá-lo com um clique diretamente no contexto do chat com IA.

## ✨ Recursos

- ⚡ **Auto-Detecção de Portas Locais**: reconhece automaticamente servidores de desenvolvimento em execução no terminal (`npm run dev` na porta 8080, 5173, 3000, etc.) e conecta automaticamente sem você precisar digitar a porta manualmente.
- 📱 **Alternador de Visualização Responsiva**:
  - 💻 **PC / Desktop (100%)**: tela inteira responsiva para desktop.
  - 📱 **Celular (390 × 844 px)**: moldura de smartphone (iPhone/Android) com cantos arredondados e sombra.
  - 📟 **Tablet (768 × 1024 px)**: visualização em tela de tablet (iPad).
  - 🔄 **Girar Orientação**: alterna rapidamente entre modo Retrato e Paisagem.
- 🎨 **Proxy Reverso Completo**: carrega todos os arquivos CSS, scripts TypeScript/JavaScript, imagens SVG/PNG, fontes e conexões WebSocket do Vite HMR (Hot Module Replacement) perfeitamente.
- 🎯 **Ferramenta de Inspeção de Elementos `[ 🖥️ ↖ ]`**: clique no botão de inspeção e passe o mouse sobre qualquer elemento na tela. Uma caixa azul com badge da tag, classes e dimensões acompanha o cursor.
- 💬 **Injeção Automática no Chat do Antigravity**: ao clicar no elemento, o seletor CSS, código HTML, texto e componente são formatados e injetados diretamente na conversa com o agente!
- ⚛️ **Detecção de Componentes React & Vue**: identifica automaticamente o nome do componente (ex: `<Header>`, `<AuditLogsCard>`) e o arquivo/linha do código fonte via React Fiber (`_debugSource`).
- 📂 **Botão "Abrir Código"**: pula instantaneamente para a linha do arquivo no editor onde o componente foi definido.
- 📋 **Cópia Instantânea**: também copia o contexto formatado em Markdown para o clipboard.

## 🚀 Como Usar

1. Pressione <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> e digite:
   `Antigravity Browser: Abrir Browser Tab`
   *(Ou clique no ícone de globo na barra inferior ou na barra de títulos)*
2. A extensão reconhece automaticamente a porta em que seu projeto está rodando (ex: `:8080`).
3. Alterne entre **PC**, **Celular** ou **Tablet** na barra superior conforme desejar testar a responsividade.
4. Clique no botão **Inspecionar** `[ 🖥️ ↖ ]`.
5. Passe o mouse e clique no elemento visual que deseja alterar na sua aplicação.
6. O elemento é capturado e enviado diretamente para o chat do Antigravity!
