'use strict';

// Punto de entrada en Vercel. La app de Express se construye una sola vez por
// instancia (al importar el módulo) y se reutiliza en cada invocación; aquí
// solo se reexporta. En local no se usa: `npm start` ejecuta server.js directo.
module.exports = require('../server.js');
