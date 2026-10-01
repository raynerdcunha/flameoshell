#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <limits.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <stdlib.h>
#include <signal.h>
#include <fcntl.h>
#include <errno.h>

#define LINE_LENGTH 100
#define ARGV_LEN (LINE_LENGTH/2 + 2)
#define JOB_LENGTH 64

extern char **environ;

typedef struct {
  int pid;
  char status;              // 'R' running, 'T' stopped
  char cmdline[LINE_LENGTH+2];
} job_list;
job_list job[JOB_LENGTH];

//SIGCHLD handler: deliberately does nothing except exist. Registered
//without SA_RESTART so a blocked fgets() in the prompt loop wakes up
//(EINTR) the instant a child changes state, instead of only noticing
//on the next keypress. Actual reaping happens in checker(), since
//waitpid/strcpy/printf aren't all safe to call from a signal handler.
void sigchld_handler(int sig) {
  (void)sig;
}

//waitpid, but retried on EINTR. Since SIGCHLD is installed without
//SA_RESTART (so a blocked fgets() can be woken for async Done
//notifications), ANY blocking waitpid() below can be interrupted by an
//unrelated SIGCHLD (e.g. a different background job finishing). Without
//retrying, waitpid returns -1 without touching *status, and reading
//WIFSTOPPED/WIFSIGNALED on that uninitialised memory is undefined
//behavior. This helper guarantees status is only ever read after a
//genuine successful reap.
static pid_t waitpid_retry(pid_t pid, int* status, int options) {
  pid_t result;
  do {
    result = waitpid(pid, status, options);
  } while (result == -1 && errno == EINTR);
  return result;
}

//reset a freshly-forked child back to default signal handling
static void reset_child_signals(void) {
  struct sigaction sa;
  sa.sa_handler = SIG_DFL;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTSTP, &sa, NULL);
}

/**
 * @brief Tokenize a C string
 *
 * @param str - The C string to tokenize
 * @param delim - The C string containing delimiter character(s)
 * @param argv - A char* array that will contain the tokenized strings
 * Make sure that you allocate enough space for the array.
 */
void tokenize(char* str, const char* delim, char ** argv) {
  char* token;
  token = strtok(str, delim);
  for(size_t i = 0; token != NULL; ++i){
    argv[i] = token;
    token = strtok(NULL, delim);
  }
}

//pwd function
void pwd() {
  char cwd[PATH_MAX] = {0};
  if (getcwd(cwd, sizeof(cwd)) != NULL) {
    printf("%s\n",cwd);
    return;
  }
}

//cd function
void cd(char* dir) {
  if (dir == NULL) {
    printf("flameoshell: Expected argument to \"cd\"\n");
  } else if (chdir(dir) == -1) {
    printf("flameoshell: No such file or directory\n");
  }
}

void protectQuotedSpaces(char* str) {
  int inquotes = 0;
  for (int i = 0; str[i] != '\0'; i++) {
    if (str[i] == '"') {
      inquotes = !inquotes;
    } else if (str[i] == ' ' && inquotes) {
      str[i] = '\x01';
    }
  }
}

char* stripArg(char* s) {
  int len = strlen(s);
  if (len >= 2 && s[0] == '"' && s[len-1] == '"') {
    s[len-1] = '\0';
    s = s + 1;
    len -= 2;
  }
  for (int c = 0; s[c] != '\0'; c++) {
    if (s[c] == '\x01') {
      s[c] = ' ';
    }
  }
  return s;
}

//Resolve a bare command name against $PATH, like a real shell.
//If cmd already contains a '/', it's used as-is (absolute/relative path).
//Returns a pointer to a static buffer -- only safe to call from a
//freshly-forked child (each child has its own private copy after fork),
//never from the parent with results used across multiple children.
char* resolve_path(char* cmd) {
  static char pathbuf[PATH_MAX];
  if (cmd == NULL) {
    return NULL;
  }
  if (strchr(cmd, '/') != NULL) {
    if (access(cmd, X_OK) == 0) {
      return cmd;
    }
    return NULL;
  }
  char* pathenv = getenv("PATH");
  if (pathenv == NULL) {
    return NULL;
  }
  char pathcopy[PATH_MAX];
  strncpy(pathcopy, pathenv, sizeof(pathcopy)-1);
  pathcopy[sizeof(pathcopy)-1] = '\0';
  char* dir = strtok(pathcopy, ":");
  while (dir != NULL) {
    snprintf(pathbuf, sizeof(pathbuf), "%s/%s", dir, cmd);
    if (access(pathbuf, X_OK) == 0) {
      return pathbuf;
    }
    dir = strtok(NULL, ":");
  }
  return NULL;
}

//checker function: reaps any background job that has finished, prints
//a "Done" notice for each one, and compacts the table so live entries
//stay packed from index 0 onward. Called once per prompt loop (and from
//jobs()) so every command sees an up-to-date table.
void checker() {
  int closed_idx[JOB_LENGTH];
  int closed_n = 0;
  for (int i=0; i<JOB_LENGTH; i++) {
    if (job[i].pid != 0) {
      int status;
      pid_t result = waitpid(job[i].pid, &status, WNOHANG);
      if (result == 0) {
        closed_idx[closed_n] = i;
        closed_n++;
      } else if (result == job[i].pid) {
        printf("[%d] Done    %s", job[i].pid, job[i].cmdline);
        job[i].pid = 0;
      }
    }
  }
  for (int i=0;i<closed_n;i++) {
    if (i != closed_idx[i]) {
      job[i].pid = job[closed_idx[i]].pid;
      job[i].status = job[closed_idx[i]].status;
      strcpy(job[i].cmdline,job[closed_idx[i]].cmdline);
    }
  }
  for (int i=closed_n;i<JOB_LENGTH;i++) {
    job[i].pid = 0;
    job[i].status = '\0';
    strcpy(job[i].cmdline, " ");
  }
}

//jobs function
void jobs() {
  checker();
  int count = 1;
  for (int i=0; i<JOB_LENGTH; i++) {
    if (job[i].pid != 0) {
      printf("[%d] %d %c %s",count,job[i].pid,job[i].status,job[i].cmdline);
      count++;
    }
  }
}

//run a two-stage pipeline (always foreground; spec doesn't combine
//piping with & or redirection). Both children share one process group
//so the terminal (and Ctrl-C/Ctrl-Z) can be handed to them as a unit.
//If the pipeline is stopped (Ctrl-Z), it's tracked in the job table
//under pid1 -- since pid1 is also the group id, bg/fg/exit's existing
//kill(-pid, ...) calls correctly signal both children as a unit. One
//documented simplification: only pid1 is explicitly reaped afterward;
//pid2 may briefly zombie until the shell itself exits (harmless -- it's
//cleaned up automatically once the shell process ends).
void run_pipeline(char* cmd1, char* cmd2, char* original) {
  char* argv1[ARGV_LEN] = {0};
  char* argv2[ARGV_LEN] = {0};
  protectQuotedSpaces(cmd1);
  protectQuotedSpaces(cmd2);
  tokenize(cmd1, " \t\n", argv1);
  tokenize(cmd2, " \t\n", argv2);
  for (int j=0;j<ARGV_LEN;j++) {
    if (argv1[j] == NULL) break;
    argv1[j] = stripArg(argv1[j]);
  }
  for (int j=0;j<ARGV_LEN;j++) {
    if (argv2[j] == NULL) break;
    argv2[j] = stripArg(argv2[j]);
  }

  int fd[2];
  if (pipe(fd) == -1) {
    perror("flameoshell: pipe failed");
    return;
  }
  pid_t pid1 = fork();
  if (pid1 == 0) {
    reset_child_signals();
    setpgid(0, 0);
    dup2(fd[1], STDOUT_FILENO);
    close(fd[0]);
    close(fd[1]);
    char* p = resolve_path(argv1[0]);
    if (p != NULL) {
      execve(p, argv1, environ);
    }
    printf("flameoshell: Command not found\n");
    _exit(1);
  }
  setpgid(pid1, pid1);
  pid_t pid2 = fork();
  if (pid2 == 0) {
    reset_child_signals();
    setpgid(0, pid1);
    dup2(fd[0], STDIN_FILENO);
    close(fd[0]);
    close(fd[1]);
    char* p = resolve_path(argv2[0]);
    if (p != NULL) {
      execve(p, argv2, environ);
    }
    printf("flameoshell: Command not found\n");
    _exit(1);
  }
  setpgid(pid2, pid1);
  close(fd[0]);
  close(fd[1]);

  tcsetpgrp(STDIN_FILENO, pid1);
  int status;
  waitpid_retry(pid1, &status, WUNTRACED);
  if (WIFSTOPPED(status)) {
    printf("\n");
    tcsetpgrp(STDIN_FILENO, getpgrp());
    for (int i = 0; i < JOB_LENGTH; i++) {
      if (job[i].pid == 0) {
        job[i].pid = pid1;
        job[i].status = 'T';
        strcpy(job[i].cmdline, original);
        break;
      }
    }
    return;   //don't block on pid2 here -- it's stopped too (same group)
  }
  waitpid_retry(pid2, NULL, 0);
  tcsetpgrp(STDIN_FILENO, getpgrp());
}

//run a single external command: parses &, <, > out of the token list,
//forks/execs with its own process group, and either waits in the
//foreground (handing it the terminal) or records it as a background job.
void run_single(char* input, char* original) {
  char* myargs[ARGV_LEN] = {0};
  int pass = 0;
  char* infile = NULL;
  char* outfile = NULL;
  protectQuotedSpaces(input);
  tokenize(input, " \t\n", myargs);
  char* cleanargs[ARGV_LEN] = {0};
  int k = 0;
  for (int j=0;j<ARGV_LEN;j++) {
    if (myargs[j] == NULL) {
      break;
    } else if (strcmp(myargs[j],"&") == 0) {
      pass = 1;
      break;
    } else if (strcmp(myargs[j],"<") == 0) {
      if (j+1 >= ARGV_LEN || myargs[j+1] == NULL) {
        break;
      }
      infile = stripArg(myargs[j+1]);
      j++;
    } else if (strcmp(myargs[j],">") == 0) {
      if (j+1 >= ARGV_LEN || myargs[j+1] == NULL) {
        break;
      }
      outfile = stripArg(myargs[j+1]);
      j++;
    } else {
      cleanargs[k] = stripArg(myargs[j]);
      k++;
    }
  }
  cleanargs[k] = NULL;

  pid_t pid = fork();
  if (pid == 0) {
    reset_child_signals();
    setpgid(0, 0);
    if (infile != NULL) {
      int fdin = open(infile, O_RDONLY);
      if (fdin == -1) {
        perror("flameoshell: cannot open input file");
        _exit(1);
      }
      dup2(fdin, STDIN_FILENO);
      close(fdin);
    }
    if (outfile != NULL) {
      int fdout = open(outfile, O_WRONLY | O_CREAT | O_TRUNC, 0644);
      if (fdout == -1) {
        perror("flameoshell: cannot open output file");
        _exit(1);
      }
      dup2(fdout, STDOUT_FILENO);
      close(fdout);
    }
    char* p = resolve_path(cleanargs[0]);
    if (p != NULL) {
      execve(p, cleanargs, environ);
    }
    printf("flameoshell: Command not found\n");
    _exit(1);
  } else if (pid > 0) {
    setpgid(pid, pid);
    if (pass == 0) {
      int status;
      tcsetpgrp(STDIN_FILENO, pid);
      waitpid_retry(pid, &status, WUNTRACED);
      tcsetpgrp(STDIN_FILENO, getpgrp());
      if (WIFSTOPPED(status)) {
        printf("\n");
        for (int i = 0; i < JOB_LENGTH; i++) {
          if (job[i].pid == 0) {
              job[i].pid = pid;
              job[i].status = 'T';
              strcpy(job[i].cmdline, original);
              break;
          }
        }
      } else if (WIFSIGNALED(status)) {
        printf("\n");
      }
    } else {
      for (int i = 0; i < JOB_LENGTH; i++) {
          if (job[i].pid == 0) {
              job[i].pid = pid;
              job[i].status = 'R';
              strcpy(job[i].cmdline, original);
              printf("PID %d is sent to background\n", pid);
              break;
          }
      }
    }
  } else {
    perror("flameoshell: fork failed");
    exit(1);
  }
}

//find the first '|' that's NOT inside a quoted string, or NULL if
//there isn't one. Used by tasks() so a literal pipe character written
//inside "..." (e.g. echo "a | b") is treated as text, not a pipeline
//separator -- mirrors the quote-awareness protectQuotedSpaces() already
//gives spaces, but has to run before the string is split/protected.
char* find_unquoted_pipe(char* str) {
  int inquotes = 0;
  for (int i = 0; str[i] != '\0'; i++) {
    if (str[i] == '"') {
      inquotes = !inquotes;
    } else if (str[i] == '|' && !inquotes) {
      return &str[i];
    }
  }
  return NULL;
}

//tasks function: top-level dispatcher, decides pipe vs single command
void tasks(char* input) {
  char original[LINE_LENGTH+2];
  strcpy(original, input);
  char* pipepos = find_unquoted_pipe(input);
  if (pipepos != NULL) {
    *pipepos = '\0';
    run_pipeline(input, pipepos + 1, original);
    return;
  }
  run_single(input, original);
}

//bg function
void bg(int index) {
  if (index < 0 || index >= JOB_LENGTH || job[index].pid == 0) {
    printf("flameoshell: bg: job index not found\n");
  } else if (job[index].status == 'R') {
    printf("flameoshell: bg: job already running\n");
  } else if (job[index].status == 'T') {
    job[index].status = 'R';
    printf("Process %d is sent to background\n",job[index].pid);
    kill(-job[index].pid, SIGCONT);
    int last = index;
    while (last + 1 < JOB_LENGTH && job[last+1].pid != 0) {
      last++;
    }
    job_list temp = job[index];
    for (int i = index; i < last; i++) {
      job[i] = job[i+1];
    }
    job[last] = temp;
  }
}

//fg function
void fg(int index) {
  if (index < 0 || index >= JOB_LENGTH || job[index].pid == 0) {
    printf("flameoshell: fg: job index not found\n");
    return;
  }
  int pid = job[index].pid;
  printf("Process %d brought to foreground\n", pid);
  tcsetpgrp(STDIN_FILENO, pid);
  if (job[index].status == 'T') {
    kill(-pid, SIGCONT);
  }
  int status;
  waitpid_retry(pid, &status, WUNTRACED);
  tcsetpgrp(STDIN_FILENO, getpgrp());
  if (WIFSTOPPED(status)) {
    printf("\n");
    job[index].status = 'T';
  } else {
    int last = index;
    while (last + 1 < JOB_LENGTH && job[last+1].pid != 0) {
      last++;
    }
    for (int i = index; i < last; i++) {
      job[i] = job[i+1];
    }
    job[last].pid = 0;
    job[last].status = '\0';
    strcpy(job[last].cmdline, " ");
  }
}

//exit function
void exit_prg() {
  for (int i =0;i<JOB_LENGTH;i++) {
    if (job[i].pid != 0) {
      kill(-job[i].pid, SIGCONT);
      kill(-job[i].pid, SIGTERM);
      waitpid_retry(job[i].pid, NULL, 0);
    }
  }
  exit(0);
}

int main(int argc, char **argv) {
  (void)argc;   //unused -- flameoshell takes no command-line arguments
  (void)argv;
  char input_line[LINE_LENGTH+2];
  char input_line2[LINE_LENGTH+2];

  setvbuf(stdout, NULL, _IONBF, 0);

  struct sigaction sa_ign;
  sa_ign.sa_handler = SIG_IGN;
  sigemptyset(&sa_ign.sa_mask);
  sa_ign.sa_flags = 0;
  sigaction(SIGINT, &sa_ign, NULL);
  sigaction(SIGTSTP, &sa_ign, NULL);
  sigaction(SIGTTOU, &sa_ign, NULL);
  sigaction(SIGTTIN, &sa_ign, NULL);

  struct sigaction sa_chld;
  sa_chld.sa_handler = sigchld_handler;
  sigemptyset(&sa_chld.sa_mask);
  sa_chld.sa_flags = 0;   //no SA_RESTART: lets a blocked fgets() wake up immediately
  sigaction(SIGCHLD, &sa_chld, NULL);

  pid_t shell_pid = getpid();
  setpgid(shell_pid, shell_pid);
  tcsetpgrp(STDIN_FILENO, shell_pid);

  while (1) {
    checker();
    printf("flameoshell > ");
    //retry fgets internally on EINTR (a job finishing/continuing woke us
    //up) instead of looping back through the outer while, which would
    //reprint the prompt a second time
    while (fgets(input_line, sizeof(input_line), stdin) == NULL) {
      if (errno != EINTR) {
        printf("\n");
        exit_prg();
      }
      checker();   //report whatever just happened right away
      clearerr(stdin);
    }
    char* myargs[ARGV_LEN] = {0};
    strcpy(input_line2,input_line);
    //protect spaces inside "..." before tokenizing the raw line, so a
    //quoted argument to a builtin (e.g. cd "my dir") stays one token
    //instead of being split on the space the quotes were meant to protect
    protectQuotedSpaces(input_line);
    tokenize(input_line, " \t\n", myargs);
    if (myargs[0] == NULL) {
      continue;
    } else if (strcmp(myargs[0], "pwd") == 0) {
      pwd();
    } else if (strcmp(myargs[0], "cd") == 0) {
      cd(myargs[1] != NULL ? stripArg(myargs[1]) : NULL);
    } else if (strcmp(myargs[0], "jobs") == 0) {
      jobs();
    } else if (strcmp(myargs[0], "exit") == 0) {
      exit_prg();
    } else if (strcmp(myargs[0], "bg") == 0) {
      if (myargs[1] == NULL) {
        printf("flameoshell: bg: job index not found\n");
      } else {
        bg(atoi(myargs[1])-1);
      }
    } else if (strcmp(myargs[0], "fg") == 0) {
      if (myargs[1] == NULL) {
        printf("flameoshell: fg: job index not found\n");
      } else {
        fg(atoi(myargs[1])-1);
      }
    } else {
      tasks(input_line2);
    }
  }

  return 0;
}