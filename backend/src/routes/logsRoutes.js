// backend/src/routes/logRoutes.js
const express = require('express');
const router = express.Router();
const logsController = require('../controllers/logsController');

router.get('/health', logsController.getLogsHealth);
router.get('/', logsController.getAllLogs);
router.post('/add', logsController.createLogEntry);

module.exports = router;