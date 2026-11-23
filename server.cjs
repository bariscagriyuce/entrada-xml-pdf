// Arquivo de inicialização. Funciona com "node server.cjs", "npm start" e com hospedagens que
// carregam o arquivo com require() (Phusion Passenger, LiteSpeed). Ele apenas carrega a aplicação ES module.
process.on('uncaughtException', (err) => console.error('[arquivo-nfe] Erro não tratado:', err));
process.on('unhandledRejection', (err) => console.error('[arquivo-nfe] Promessa rejeitada:', err));

import('./app.js').catch((err) => {
  console.error('[arquivo-nfe] Falha ao iniciar a aplicação:', err);
  process.exit(1);
});
