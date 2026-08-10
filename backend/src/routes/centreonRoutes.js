const express = require('express');
const router = express.Router();
const centreonController = require('../controllers/centreonController');

// Host endpoints
router.get('/hosts/status/all', centreonController.getHostStatus);
router.get('/hosts', centreonController.getAllHosts);
router.get('/hosts/:id', centreonController.getHostById);

// Poller endpoints
router.get('/pollers', centreonController.getAllPollers);
router.get('/pollers/:pollerId/hosts', centreonController.getPollerHosts);
router.get('/pollers/:pollerId/services/summary', centreonController.getPollerServiceSummary);

// Data Center endpoints
router.get('/datacenter/hostgroups', centreonController.getDataCenterHostGroups);

// Acknowledgement endpoints
router.post('/acknowledge', centreonController.acknowledgeService);
router.post('/unacknowledge', centreonController.unacknowledgeService);

// Temporary test endpoint for real Centreon poller names
router.get('/test-monitoring-servers', centreonController.testMonitoringServers);

// Service endpoints
router.get('/services/search', centreonController.searchServicesGlobally);
router.get('/services/status/summary', centreonController.getServiceStatusSummary);
router.get('/services/status/global-summary', centreonController.getGlobalServiceStatusSummary);
router.get('/services/status/global-summary/list', centreonController.getGlobalServiceStatusSummaryList);
router.get('/services/status/global-summary/options', centreonController.getGlobalServiceFilterOptions);
router.get('/services/status/resources-parity', centreonController.getGlobalServiceResourcesParity);
router.get('/services', centreonController.getAllServices);
router.get('/services/host/:hostId', centreonController.getServicesByHost);

module.exports = router;