import { create } from 'zustand';

export const useStore = create((set, get) => ({
  // Data
  projects: [],
  sessions: [],
  messages: [],
  currentModel: null,
  availableModels: [],

  // UI state
  selectedProject: null,
  selectedSession: null,
  loading: false,
  error: null,
  searchQuery: '',
  sidebarCollapsed: false,

  // Actions
  setProjects: (projects) => set({ projects }),
  setSessions: (sessions) => set({ sessions }),
  setMessages: (messages) => set({ messages }),
  setCurrentModel: (model) => set({ currentModel: model }),
  setSelectedProject: (project) => set({ selectedProject: project, selectedSession: null, messages: [] }),
  setSelectedSession: (session) => set({ selectedSession: session }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // Fetch projects
  fetchProjects: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/api/projects');
      const projects = await res.json();
      set({ projects, loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  // Fetch sessions for a project
  fetchSessions: async (projectHash) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectHash)}/sessions`);
      const sessions = await res.json();
      set({ sessions, loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  // Fetch messages for a session
  fetchMessages: async (sessionId, projectHash) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/messages?projectHash=${encodeURIComponent(projectHash)}`
      );
      const messages = await res.json();
      set({ messages, loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  // Fetch current model
  fetchModel: async () => {
    try {
      const res = await fetch('/api/model');
      const data = await res.json();
      set({ currentModel: data.model, availableModels: data.available || [] });
    } catch {}
  },

  // Set model (just updates local state, API call happens via ModelSelector)
  setModel: (modelId) => {
    set({ currentModel: modelId });
    // Persist to server
    fetch('/api/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
    }).catch(() => {});
  },
}));
