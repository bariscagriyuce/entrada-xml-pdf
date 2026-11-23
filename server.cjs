// Arquivo de inicialização para hospedagens com Phusion Passenger (cPanel "Setup Node.js App"),
// que carregam o arquivo de inicialização com require(). Ele apenas carrega a aplicação ES module.
import('./app.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
