const mysql = require('mysql2/promise');
require('dotenv').config();

// Connect to your remote MySQL Database (WordPress DB)
const authPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = authPool;
