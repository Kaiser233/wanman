export interface ProjectRunSpec<THooks = unknown> {
  projectDir?: string
  repoSourceDir?: string
  repoCloneUrl?: string
  workspaceRoot?: string
  gitRoot?: string
  sourceLabel?: string
  bootstrapScript?: string
  githubToken?: string
  hooks?: THooks
}
