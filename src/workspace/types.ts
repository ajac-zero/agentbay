export type EmptyWorkspace = {
  type: "empty";
};

export type GitWorkspaceSelector = {
  type: "git";
  repository: {
    url: {
      path: string;
    };
  };
  revision: {
    commit: {
      path: string;
    };
  };
};

export type BindingWorkspace = EmptyWorkspace | GitWorkspaceSelector;

export type ResolvedGitWorkspace = {
  type: "git";
  repository: {
    url: string;
  };
  revision: {
    type: "commit";
    commit: string;
  };
};

export type ResolvedWorkspace = EmptyWorkspace | ResolvedGitWorkspace;
