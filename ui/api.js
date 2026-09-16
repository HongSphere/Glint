/* Tauri bridge — provides desktop native IPC for window.api */
(function () {
  function invoke(cmd, args) {
    if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.core.invoke) {
      return Promise.reject(new Error('Tauri API not ready'));
    }
    return window.__TAURI__.core.invoke(cmd, args);
  }

  window.api = {
    getConfig: () => invoke('commands_config_get'),
    setConfig: (partial) => invoke('commands_config_set', { partial }),
    resetConfig: () => invoke('commands_config_reset'),

    testGitLab: (form) => invoke('commands_gitlab_test', { form: form || null }),
    listProjects: (opts) => invoke('commands_gitlab_list_projects', { opts: opts || null }),
    listMergeRequests: (opts) => invoke('commands_gitlab_list_mrs', { opts: opts || null }),
    getMergeRequest: (iid) => invoke('commands_gitlab_get_mr', { iid: Number(iid) }),

    testAI: (form) => invoke('commands_ai_test', { form: form || null }),
    listSkills: () => invoke('commands_skills_list'),
    getSkill: (id) => invoke('commands_skills_get', { id }),
    setSkillDir: () => invoke('commands_skills_set_dir'),
    clearSkillDir: () => invoke('commands_skills_clear_dir'),
    pickSkillFile: () => invoke('commands_skills_pick_file'),

    runReview: (opts) => invoke('commands_review_run', { opts }),
    stopReview: () => invoke('commands_review_stop'),
    postReview: (payload) => invoke('commands_review_post', { payload }),

    appInfo: () => invoke('commands_app_info'),

    // Tauri: no-op placeholders so old UI calls don't throw
    checkUpdate: (force) => invoke('commands_updater_check', { force: !!force }),
    installUpdate: () => invoke('commands_updater_install'),
    updateState: () => invoke('commands_updater_state'),

    onReviewProgress: function (cb) {
      if (!window.__TAURI__ || !window.__TAURI__.event) return () => {};
      let unlisten = null;
      window.__TAURI__.event
        .listen('review:progress', (e) => cb(e.payload))
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
      return () => {
        if (unlisten) unlisten();
      };
    },
    onUpdateState: function (cb) {
      if (!window.__TAURI__ || !window.__TAURI__.event) return () => {};
      let unlisten = null;
      window.__TAURI__.event
        .listen('updater:state', (e) => cb(e.payload))
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
      return () => {
        if (unlisten) unlisten();
      };
    },
  };
})();
