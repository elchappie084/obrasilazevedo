# ObraFlux — Notas fiscais e boletos

## Iniciar (Node.js 20+)
1. Copie `.env.example` para `.env` e altere `ADMIN_PASSWORD` e `SESSION_SECRET`.
2. Execute `npm install`.
3. Execute `npm start`.
4. Abra `http://localhost:3000` e entre com a senha definida.

## Funcionalidades
- Banco SQLite persistente (`data/obraflux.db`).
- Cadastro, edição, exclusão e filtros de documentos.
- Upload de PDF/XML (até 15 MB por arquivo), visualização e detecção de duplicatas pelo hash SHA-256.
- Extração inicial de campos de NF-e XML (emitente, CNPJ, número, valor, emissão). PDF e boletos exigem conferência e preenchimento manual.
- Sincronização manual IMAP dos 200 e-mails mais recentes da caixa de entrada, com anexos PDF/XML. Para Gmail, use uma senha de app, se disponível; não use sua senha principal.
- CSV exportável e log de alterações básico.

## Atenção
O sistema **não envia dados ao Obra Prima**. O status “Lançado” é marcado manualmente. A sincronização com o Obra Prima requer integração autorizada/documentada. Não há processamento automático de códigos de barras ou OCR.

## Segurança e produção
Projeto inicial para uso local ou ambiente interno. Antes de publicar na internet: adicione HTTPS, controle de usuários e permissões, rate limit no login, sessões persistentes e expiração, proteção CSRF se usar cookies, criptografia/segurança dos backups e auditoria completa. Não exponha o serviço publicamente com a senha padrão. O arquivo `.env` deve permanecer privado.

## Fluxo Gmail + Obra Prima
1. Cadastre uma senha de aplicativo no Google (quando disponível para sua conta, com verificação em duas etapas). Nunca coloque a senha principal do Gmail no `.env`.
2. Preencha `IMAP_USER` e `IMAP_PASSWORD` em `.env`. Reinicie o servidor.
3. Clique **Sincronizar e-mail**. São examinadas as últimas 200 mensagens da caixa de entrada; apenas anexos PDF/XML são importados. Nenhum e-mail é excluído ou marcado como lido intencionalmente.
4. Confira os campos dos documentos. A leitura automática de XML é básica e pode exigir ajustes.
5. Lance no Obra Prima. Volte ao ObraFlux, selecione **Lançado**, registre a data e a referência.
6. Registre pagamento separadamente em **Situação do pagamento**.

A conexão do Gmail dentro do ChatGPT **não autentica automaticamente o site**. Para produção, prefira OAuth 2.0 com permissões mínimas e criptografia dos tokens em vez de senha de aplicativo.

## Versão 3 — Leitura de DANFE e boletos
- Extrai texto de PDFs digitais usando `pdf-parse`, identifica o número da NF sem pontos/zeros iniciais, data de emissão, valor total e tenta reconhecer fornecedor.
- Em boletos, identifica o vencimento e usa o valor do documento apenas para validar vínculo; não soma boletos no total do painel.
- Vincula automaticamente uma NF e um boleto **somente** se forem os únicos respectivos anexos do mesmo e-mail e tiverem exatamente o mesmo valor, ou houver referência explícita à NF e valor coincidente. Em outros casos, revisar manualmente.
- PDFs digitalizados/imagens sem camada de texto não são lidos (não há OCR). Campos de DANFE variam conforme o emissor; conferir sempre antes do lançamento.
- A senha de aplicativo IMAP continua sendo necessária nesta versão; OAuth do Google ainda não foi implementado.
