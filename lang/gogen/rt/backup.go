package rt

// Backups, by the app itself (no other tools on the server):
//
//	app backup --data <dir> [--to <folder>] [--keep <days>]
//	app backup --data <dir> --out <file>              (one copy, to that file)
//
// A copy of the database made while the app runs (SQLite's VACUUM INTO reads one consistent
// moment, beside the app's own reads and writes), then checked: SQLite's integrity check, every
// reference, and the version recorded in it. Kept in <folder> (<data>/backups when not said), as
// app-<UTC time>.sqlite. With a backup bucket set (CRUDSPEC_BACKUP_BUCKET, on the service the
// CRUDSPEC_S3_* settings name), the copy is sent to it, under db/, and so are the uploaded files
// the app keeps on this machine (<data>/files), under files/: only the ones not sent before
// (stored files never change). --keep removes copies older than that many days, in the folder
// and the bucket; the newest is always kept.
//
// Every upgrade is a checkpoint too (upgrade.go): before the upgraded database takes the old
// one's place, the old one is copied to <data>/backups and checked, and, with a backup bucket
// set, sent to it. An upgrade whose backup can't be made or sent doesn't happen.
//
// It writes what it did as one line of JSON and exits 0, or {"error": "…"} and 1.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// backupBucket is the bucket backups go to, when CRUDSPEC_BACKUP_BUCKET names one.
func backupBucket(area string) (*S3Store, error) {
	bucket := os.Getenv("CRUDSPEC_BACKUP_BUCKET")
	if bucket == "" {
		return nil, nil
	}
	return s3FromEnv(bucket, os.Getenv("CRUDSPEC_BACKUP_PREFIX")+area+"/")
}

// copyDB copies the database at path to out (which mustn't exist), as one consistent moment.
func copyDB(path, out string) error {
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s exists: a backup is a new file", out)
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("no database at %s", path)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return err
	}
	conn, err := OpenConn(path, false) // read-only: the copy is all it makes
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := conn.Exec(`VACUUM INTO ?`, out); err != nil {
		os.Remove(out)
		return errors.New("the copy: " + err.Error())
	}
	return nil
}

// checkCopy opens a backup and checks it: SQLite's integrity check, every reference, and (when
// hash isn't "") that it's at this build's schema.
func checkCopy(file, hash string) error {
	c, err := OpenConn(file, false)
	if err != nil {
		return err
	}
	defer c.Close()
	var res string
	if err := c.QueryRow(`PRAGMA integrity_check`).Scan(&res); err != nil {
		return fmt.Errorf("the copy's integrity check: %w", err)
	}
	if res != "ok" {
		return fmt.Errorf("the copy fails SQLite's integrity check: %s", res)
	}
	rows, err := c.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	bad := rows.Next()
	rows.Close()
	if bad {
		return errors.New("the copy has references to rows that don't exist")
	}
	if hash != "" {
		var h string
		if err := c.QueryRow(`SELECT schema_hash FROM crudspec_versions ORDER BY version DESC LIMIT 1`).Scan(&h); err != nil {
			return errors.New("the copy has no recorded version")
		}
		if h != hash {
			return fmt.Errorf("the copy is at schema %s, not this build's %s", h, hash)
		}
	}
	return nil
}

// sendFiles sends the files in dir the bucket doesn't have yet; it returns how many it sent.
func sendFiles(bk *S3Store, dir string) (int, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	have := map[string]bool{}
	objs, err := bk.List()
	if err != nil {
		return 0, err
	}
	for _, o := range objs {
		have[o.Key] = true
	}
	sent := 0
	for _, e := range ents {
		if e.IsDir() || !validKey(e.Name()) || have[e.Name()] {
			continue
		}
		if err := bk.PutFile(e.Name(), filepath.Join(dir, e.Name()), mime.TypeByExtension(filepath.Ext(e.Name()))); err != nil {
			return sent, err
		}
		sent++
	}
	return sent, nil
}

// prune removes the app-*.sqlite copies older than days, in the folder and the bucket, keeping
// the newest of each; it returns what it removed.
func prune(folder string, bk *S3Store, days int, now time.Time) ([]string, error) {
	cut := now.Add(-time.Duration(days) * 24 * time.Hour)
	removed := []string{}
	type item struct {
		name string
		at   time.Time
	}
	ents, _ := os.ReadDir(folder)
	local := []item{}
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), "app-") && strings.HasSuffix(e.Name(), ".sqlite") {
			if fi, err := e.Info(); err == nil {
				local = append(local, item{e.Name(), fi.ModTime()})
			}
		}
	}
	sort.Slice(local, func(i, j int) bool { return local[i].at.After(local[j].at) })
	for i, it := range local {
		if i > 0 && it.at.Before(cut) {
			if err := os.Remove(filepath.Join(folder, it.name)); err != nil {
				return removed, err
			}
			removed = append(removed, filepath.Join(folder, it.name))
		}
	}
	if bk == nil {
		return removed, nil
	}
	objs, err := bk.List()
	if err != nil {
		return removed, err
	}
	sort.Slice(objs, func(i, j int) bool { return objs[i].Modified.After(objs[j].Modified) })
	for i, o := range objs {
		if i > 0 && o.Modified.Before(cut) && strings.HasPrefix(o.Key, "app-") {
			if err := bk.Delete(o.Key); err != nil {
				return removed, err
			}
			removed = append(removed, bk.Bucket+"/"+bk.Prefix+o.Key)
		}
	}
	return removed, nil
}

func backupDB(b *Build, args []string) int {
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	data := fs.String("data", "data", "the data directory")
	out := fs.String("out", "", "one copy, to this file (it mustn't exist); nothing else is done")
	to := fs.String("to", "", "the folder copies are kept in (<data>/backups when not said)")
	keep := fs.Int("keep", 0, "remove copies older than this many days, here and in the bucket (the newest is always kept); 0 keeps them all")
	fs.Parse(args)
	say := func(code int, v map[string]any) int {
		j, _ := json.Marshal(v)
		os.Stdout.Write(append(j, '\n'))
		return code
	}
	path := filepath.Join(*data, "app.sqlite")
	if *out != "" {
		if err := copyDB(path, *out); err != nil {
			return say(1, map[string]any{"error": err.Error()})
		}
		st, err := os.Stat(*out)
		if err != nil {
			return say(1, map[string]any{"error": err.Error()})
		}
		return say(0, map[string]any{"out": *out, "bytes": st.Size()})
	}
	folder := *to
	if folder == "" {
		folder = filepath.Join(*data, "backups")
	}
	now := time.Now().UTC()
	file := filepath.Join(folder, "app-"+now.Format("20060102T150405Z")+".sqlite")
	if err := copyDB(path, file); err != nil {
		return say(1, map[string]any{"error": err.Error()})
	}
	if err := checkCopy(file, b.SchemaHash); err != nil {
		os.Remove(file)
		return say(1, map[string]any{"error": err.Error()})
	}
	st, _ := os.Stat(file)
	res := map[string]any{"out": file, "bytes": st.Size()}
	dbBucket, err := backupBucket("db")
	if err != nil {
		return say(1, map[string]any{"error": err.Error(), "out": file})
	}
	if dbBucket != nil {
		if err := dbBucket.PutFile(filepath.Base(file), file, "application/vnd.sqlite3"); err != nil {
			return say(1, map[string]any{"error": "sending the copy: " + err.Error(), "out": file})
		}
		res["sent"] = dbBucket.Bucket + "/" + dbBucket.Prefix + filepath.Base(file)
		// the uploaded files, when the app keeps them on this machine
		if os.Getenv("CRUDSPEC_S3_BUCKET") == "" {
			fb, _ := backupBucket("files")
			n, err := sendFiles(fb, filepath.Join(*data, "files"))
			res["files_sent"] = n
			if err != nil {
				res["error"] = "sending the files: " + err.Error()
				return say(1, res)
			}
		}
	}
	if *keep > 0 {
		removed, err := prune(folder, dbBucket, *keep, now)
		res["removed"] = removed
		if err != nil {
			res["error"] = "removing old copies: " + err.Error()
			return say(1, res)
		}
	}
	return say(0, res)
}

// upgradeCheckpoint is an upgrade's backup: the database as it is, copied to backup and
// checked, and sent to the backup bucket when one is set. An error stops the upgrade.
func upgradeCheckpoint(path, backup string) error {
	if err := copyDB(path, backup); err != nil {
		return err
	}
	if err := checkCopy(backup, ""); err != nil {
		os.Remove(backup)
		return err
	}
	bk, err := backupBucket("db")
	if err != nil {
		return err
	}
	if bk != nil {
		if err := bk.PutFile(filepath.Base(backup), backup, "application/vnd.sqlite3"); err != nil {
			return errors.New("sending the backup to the bucket: " + err.Error())
		}
	}
	return nil
}
