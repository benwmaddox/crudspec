package rt

// Files follow their row (lang/filereads.ts). /files/<key> is served when the visitor may read a
// row that holds the file: the build gives each entity with a File field an internal action,
// __files_<Entity>(held), that the entity's read policy guards, and this asks it of each row whose
// File column is the key. A file no row holds (its row deleted, or never saved) is no one's.

import "fmt"

const fileReads = "__files_"

// fileReadable: whether who may fetch the file stored as key.
func (sv *Server) fileReadable(r *HTTPReq, who Who, key string) bool {
	for name, e := range sv.App.Ents {
		if !e.Stored {
			continue
		}
		for _, f := range e.Fields {
			if f.Type != "File" {
				continue
			}
			rows, err := sv.App.DB.R.Query(`SELECT id FROM `+Q(name)+` WHERE `+Q(f.Name)+` = ?`, key)
			if err != nil {
				fmt.Println("files:", err)
				continue
			}
			var ids []int64
			for rows.Next() {
				var id int64
				rows.Scan(&id)
				ids = append(ids, id)
			}
			rows.Close()
			for _, id := range ids {
				if sv.App.Actions[fileReads+name] == nil {
					return true // a build without the guard (no rules for the entity)
				}
				res := sv.App.Run(r.Sess, fileReads+name, map[string]Val{"held": Ref{E: name, ID: id}}, who.Actor, r.request(who, "get"), nil)
				if res.Outcome == "ok" {
					return true
				}
			}
		}
	}
	return false
}
