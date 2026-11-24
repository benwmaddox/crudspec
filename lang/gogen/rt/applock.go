package rt

// The app that serves a data folder holds <data>/app.lock, an operating-system lock on the file
// (flock on Unix, an unshared handle on Windows) for as long as it runs, so an upgrade can't swap
// the database underneath it and two apps don't serve one database. The system lets go of it when
// the process ends however it ends (a crash, a kill, a reboot), so a stale lock can't keep the
// app from starting. The holder's process id is written in the file, for messages.

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

func lockPath(dbPath string) string { return filepath.Join(filepath.Dir(dbPath), "app.lock") }

var heldLocks = struct {
	sync.Mutex
	m map[string]*os.File
}{m: map[string]*os.File{}}

// takeLock takes the data folder's lock for this process, or says who has it: the holder's
// process id, or -1 when it can't be read.
func takeLock(dbPath string) (int, error) {
	p, _ := filepath.Abs(lockPath(dbPath))
	heldLocks.Lock()
	defer heldLocks.Unlock()
	if heldLocks.m[p] != nil {
		return 0, nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return 0, err
	}
	f, busy, err := lockFile(p)
	if err != nil {
		return 0, err
	}
	if busy {
		return holderPID(p), nil
	}
	f.Truncate(0)
	f.WriteAt([]byte(strconv.Itoa(os.Getpid())), 0)
	heldLocks.m[p] = f
	return 0, nil
}

// lockHolder is who else holds the data folder's lock (as takeLock says it), or 0.
func lockHolder(dbPath string) int {
	p, _ := filepath.Abs(lockPath(dbPath))
	heldLocks.Lock()
	defer heldLocks.Unlock()
	if heldLocks.m[p] != nil {
		return 0
	}
	if _, err := os.Stat(p); err != nil {
		return 0
	}
	f, busy, err := lockFile(p)
	if err != nil {
		return 0
	}
	if busy {
		return holderPID(p)
	}
	unlockFile(f)
	return 0
}

// releaseLock lets go of the lock, if this process holds it.
func releaseLock(dbPath string) {
	p, _ := filepath.Abs(lockPath(dbPath))
	heldLocks.Lock()
	defer heldLocks.Unlock()
	if f := heldLocks.m[p]; f != nil {
		unlockFile(f)
		delete(heldLocks.m, p)
	}
}

func holderPID(p string) int {
	b, err := os.ReadFile(p)
	if err != nil {
		return -1
	}
	if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && n > 0 {
		return n
	}
	return -1
}

// holderText names the lock's holder in a message.
func holderText(pid int) string {
	if pid > 0 {
		return fmt.Sprintf("process %d", pid)
	}
	return "another process"
}
