/* eslint-disable no-console */
const { all } = require("../db");

function main() {
  const users = all("SELECT COUNT(*) AS c FROM users")[0].c;
  const drivers = all("SELECT COUNT(*) AS c FROM drivers")[0].c;
  const deliveries = all("SELECT COUNT(*) AS c FROM deliveries")[0].c;
  console.log("SQLite migration checkpoint");
  console.log(`Users: ${users}`);
  console.log(`Drivers: ${drivers}`);
  console.log(`Deliveries: ${deliveries}`);
  console.log("Database is initialized and ready.");
}

main();
