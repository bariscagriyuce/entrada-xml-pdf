# Arquivo NF-e — Notas de Entrada

Aplicação web para importar as notas fiscais de entrada (NF-e modelo 55 / NFC-e modelo 65) em **XML**
ou **DANFE em PDF**, armazenar todos os dados e pesquisar por **fornecedor**, **produto** e **itens**.

- Interface em português, protegida por login (usuário e senha).
- Node.js **24** (recomendado; também funciona no 20 e 22).
- Não precisa de servidor de banco de dados: tudo fica em um arquivo SQLite (`dados/notas.db`).
- Nenhuma dependência exige compilação — `npm install` funciona em hospedagem compartilhada.

## Funcionalidades

- **Importar**: envio em lote de XML, PDF e ZIP (arrastar e soltar), ou copie os arquivos para
  `dados/entrada/` (por FTP ou gerenciador de arquivos) e clique em "Importar da pasta".
  Arquivos ou chaves de acesso repetidos são ignorados.
- **XML = dados completos**: emitente, destinatário, todos os itens (código, EAN, NCM, CFOP, quantidade,
  valor unitário, ICMS/IPI/PIS/COFINS), totais, transporte, duplicatas, pagamento, informações adicionais
  e protocolo da SEFAZ. A página da nota também mostra todos os campos do XML em árvore.
- **PDF (DANFE)**: se já existir a nota com a mesma chave, o PDF é anexado a ela. Se houver apenas o PDF,
  a nota é criada com os dados que puderem ser lidos (marcada como "só PDF", dados aproximados) e é
  completada automaticamente quando o XML for importado. OCR de PDFs digitalizados só funciona se o
  servidor tiver o `tesseract` instalado (em geral não existe em hospedagem compartilhada).
- **Notas / Itens / Produtos / Fornecedores**: busca sem distinção de acentos; filtros por fornecedor,
  minha empresa (destinatário), período, valor, NCM e CFOP; ordenação; **exportação CSV** (abre no Excel).
- **Produto**: histórico completo de compras, gráfico de preço unitário e outros fornecedores com o mesmo EAN.
- **Usuários**: o primeiro acesso cria o administrador; depois é possível adicionar usuários e trocar a senha.

## Implantação na Hostinger (Node.js Web App)

1. hPanel → **Sites** → **Adicionar site** → **Node.js** → **Importar repositório Git**
   e conecte o GitHub ou o GitLab. Selecione o repositório **entrada-xml-pdf** e o branch **main**.
2. Em **Revisar configurações de compilação**:
   - Configuração predefinida: **Express**
   - Versão do Node: **24.x**
   - Diretório raiz: `./`
   - Comando de build: `npm run build`
   - Arquivo de entrada: **`server.cjs`** (ou comando de início `npm start`)
3. Em **Variáveis de ambiente**, adicione `NFE_DADOS` apontando para uma pasta **fora** da pasta da
   aplicação, por exemplo `/home/u123456789/entrada-dados`. Assim os dados não são apagados a cada nova
   implantação.
4. Clique em implantar e abra o domínio. A primeira tela é **"Primeiro acesso"** para criar o administrador.

A cada novo commit no branch `main`, a Hostinger pode implantar a atualização automaticamente.

## Implantação no cPanel ("Setup Node.js App")

1. cPanel → **Git Version Control** → **Create** → "Clone a Repository":
   - Clone URL: `https://github.com/bariscagriyuce/entrada-xml-pdf.git`
   - Repository Path: por exemplo `arquivo-nfe` (**não** use `public_html`)
2. cPanel → **Setup Node.js App** → **Create Application**:
   - Node.js version: 24 (ou 20/22)
   - Application mode: Production
   - Application root: `arquivo-nfe`
   - Application URL: seu domínio ou subdomínio
   - Application startup file: **`server.cjs`**
3. **Run NPM Install** → **Restart**.
4. Para atualizar: **Git Version Control** → **Update from Remote** e depois **Restart** no aplicativo Node.js.

Ative o **SSL (https)** no domínio antes de usar o sistema.

### Variáveis de ambiente (opcionais)

| Variável | Significado |
|---|---|
| `NFE_DADOS` | Pasta dos dados (padrão: `dados/` dentro da aplicação) |
| `BASE_PATH` | Caminho, se a aplicação ficar em uma subpasta (ex.: `/notas`) |
| `PORT` | Porta (a hospedagem normalmente define sozinha; localmente o padrão é 3000) |

## Executar localmente

```bash
npm install
npm start
```

Depois acesse http://localhost:3000

## Backup

Todos os dados ficam na pasta de dados (`dados/` ou a definida em `NFE_DADOS`): o banco `notas.db`
e os XML/PDF originais em `arquivos/`. Faça download dessa pasta periodicamente.
A pasta de dados **nunca** é enviada ao repositório Git (está no `.gitignore`).
