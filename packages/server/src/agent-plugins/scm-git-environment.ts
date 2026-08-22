const GIT_CREDENTIAL_HELPER = [
  "!f() {",
  "test \"$1\" = get || exit 0;",
  "printf 'username=%s\\npassword=%s\\n' \"$MULTIREMI_SCM_GIT_USERNAME\" \"$MULTIREMI_SCM_GIT_PASSWORD\";",
  "}; f",
].join(" ");

export function createScmGitCredentialEnvironment(
  username: string,
  password: string,
): Record<string, string> {
  return {
    MULTIREMI_SCM_GIT_AUTH: "1",
    MULTIREMI_SCM_GIT_USERNAME: username,
    MULTIREMI_SCM_GIT_PASSWORD: password,
  };
}

export function scmGitCredentialArguments(environment: Record<string, string>): string[] {
  return environment.MULTIREMI_SCM_GIT_AUTH === "1"
    ? [
        "-c",
        "credential.helper=",
        "-c",
        `credential.helper=${GIT_CREDENTIAL_HELPER}`,
        "-c",
        "credential.useHttpPath=true",
      ]
    : [];
}
