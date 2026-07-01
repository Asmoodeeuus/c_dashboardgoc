const express = require('express');
const router = express.Router();
const centreonController = require('../controllers/centreonController');

// Host endpoints
router.get('/hosts/status/all', centreonController.getHostStatus);
router.get('/hosts', centreonController.getAllHosts);
router.get('/hosts/:id', centreonController.getHostById);

// Service endpoints
// router.get('/services/problems/summary', centreonController.getProblemServicesSummary);
router.get('/services/search', centreonController.searchServicesGlobally);
router.get('/services/status/summary', centreonController.getServiceStatusSummary);
router.get('/services', centreonController.getAllServices);
router.get('/services/host/:hostId', centreonController.getServicesByHost);

module.exports = router;