package rt

// The running app holds <data>/app.lock (its process id), so an upgrade can't swap the database
// underneath it, and two apps don't serve one database. A lock whose process has gone is stale
// and ignored.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func lockPath(dbPath string) string { return filepath.Join(filepath.Dir(dbPath), "app.lock") }

// lockHolder is the id of another live process holding the lock, or 0.
func lockHolder(dbPath string) int {
	b, err := os.ReadFile(lockPath(dbPath))
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if pid <= 0 || pid == os.Getpid() || !processAlive(pid) {
		return 0
	}
	return pid
}

// takeLock takes the lock for this process; it returns the other holder's id when it's taken.
func takeLock(dbPath string) (int, error) {
	if other := lockHolder(dbPath); other != 0 {
		return other, nil
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return 0, err
	}
	return 0, os.WriteFile(lockPath(dbPath), []byte(strconv.Itoa(os.Getpid())), 0o644)
}

// releaseLock gives the lock up, if this process holds it.
func releaseLock(dbPath string) {
	if b, err := os.ReadFile(lockPath(dbPath)); err == nil && strings.TrimSpace(string(b)) == strconv.Itoa(os.Getpid()) {
		os.Remove(lockPath(dbPath))
	}
}
