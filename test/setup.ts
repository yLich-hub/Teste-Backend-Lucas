// Os testes usam um banco separado (wagering_test) para não disputar a outbox
// com as instâncias da aplicação que estejam rodando no docker-compose.
process.env.DATABASE_URL ??= 'postgres://wagering:wagering@localhost:5432/wagering_test';
