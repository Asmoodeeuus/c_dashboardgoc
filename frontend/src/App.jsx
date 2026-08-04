import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from "./components/Dashboard.jsx";
import Login from "./components/Login.jsx";
import Logout from "./components/Logout.jsx";
import Pollers from "./components/Pollers.jsx";
import Logs from "./components/Logs.jsx";
import './App.css'; 

function App() {
  return (
    <Routes>
      {/* 1. Public Authentication Routes */}
      <Route path="/login" element={<Login />} />
      <Route path="/logout" element={<Logout />} />

      {/* 2. Protected Dashboard Workspace */}
      {/* The '*' wildcard catches paths like /dashboard, /sla, /pollers, /logs */}
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/pollers" element={<Dashboard />} />
      <Route path="/logs" element={<Dashboard />} />
      <Route path="/datacenter" element={<Dashboard />} />


      {/* 3. Fallback: Redirect any unknown path back to login */}
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default App;