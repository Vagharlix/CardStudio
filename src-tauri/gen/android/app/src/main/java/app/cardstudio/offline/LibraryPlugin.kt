package app.cardstudio.offline

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.Executors

@InvokeArg
class LibraryArgs {
  var tree: String? = null
  var name: String? = null
  var text: String? = null
  var base64: String? = null
  var asBase64: Boolean = false
}

/**
 * Card library in a folder the user picks with the system folder picker
 * (Storage Access Framework). The app keeps access to it across restarts,
 * the files stay when the app is uninstalled, and the folder can be copied
 * to another phone. Called from src-tauri/src/library.rs.
 */
@TauriPlugin
class LibraryPlugin(private val activity: Activity) : Plugin(activity) {
  // One thread: file operations run in order and off the UI thread.
  private val io = Executors.newSingleThreadExecutor()
  // "<tree>\n<file name>" -> document id
  private val ids = HashMap<String, String>()
  private val readWrite = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

  private class Child(val id: String, val name: String, val size: Long, val modified: Long)

  private fun background(invoke: Invoke, work: (LibraryArgs) -> JSObject) {
    val args = try {
      invoke.parseArgs(LibraryArgs::class.java)
    } catch (e: Exception) {
      invoke.reject("Bad arguments: ${e.message}")
      return
    }
    io.execute {
      try {
        invoke.resolve(work(args))
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  private fun treeOf(args: LibraryArgs): Uri =
    Uri.parse(args.tree?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("No folder chosen"))

  private fun nameOf(args: LibraryArgs): String =
    args.name?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("No file name")

  private fun hasAccess(tree: Uri): Boolean =
    activity.contentResolver.persistedUriPermissions.any {
      it.uri == tree && it.isReadPermission && it.isWritePermission
    }

  private fun rootDocument(tree: Uri): Uri =
    DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

  private fun displayName(doc: Uri): String? =
    activity.contentResolver.query(doc, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }

  private fun cacheKey(tree: Uri, name: String) = tree.toString() + "\n" + name

  /** Files of the folder (no subfolders); refreshes the id cache. */
  private fun children(tree: Uri): List<Child> {
    val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    val columns = arrayOf(
      Document.COLUMN_DOCUMENT_ID,
      Document.COLUMN_DISPLAY_NAME,
      Document.COLUMN_SIZE,
      Document.COLUMN_LAST_MODIFIED,
      Document.COLUMN_MIME_TYPE
    )
    val out = ArrayList<Child>()
    activity.contentResolver.query(uri, columns, null, null, null)?.use { c ->
      while (c.moveToNext()) {
        if (c.getString(4) == Document.MIME_TYPE_DIR) continue
        val id = c.getString(0) ?: continue
        val name = c.getString(1) ?: continue
        val size = if (c.isNull(2)) 0L else c.getLong(2)
        val modified = if (c.isNull(3)) 0L else c.getLong(3)
        out.add(Child(id, name, size, modified))
      }
    } ?: throw IOException("Cannot open the folder")
    val prefix = tree.toString() + "\n"
    ids.keys.removeAll { it.startsWith(prefix) }
    for (child in out) ids[prefix + child.name] = child.id
    return out
  }

  private fun find(tree: Uri, name: String): Uri? {
    val id = ids[cacheKey(tree, name)] ?: children(tree).firstOrNull { it.name == name }?.id ?: return null
    return DocumentsContract.buildDocumentUriUsingTree(tree, id)
  }

  /** Runs [block] on the document named [name], refreshing a stale cached id once. */
  private fun <T> withDocument(tree: Uri, name: String, block: (Uri) -> T): T {
    val doc = find(tree, name) ?: throw FileNotFoundException(name)
    return try {
      block(doc)
    } catch (e: FileNotFoundException) {
      children(tree)
      block(find(tree, name) ?: throw e)
    }
  }

  private fun mimeOf(name: String) =
    if (name.lowercase().endsWith(".jpg")) "image/jpeg" else "application/octet-stream"

  private fun writeBytes(doc: Uri, bytes: ByteArray) {
    val resolver = activity.contentResolver
    val stream = try {
      resolver.openOutputStream(doc, "wt")
    } catch (e: Exception) {
      resolver.openOutputStream(doc, "w")
    } ?: throw IOException("Cannot write the file")
    stream.use {
      it.write(bytes)
      it.flush()
      // make sure the card is on disk before reporting success
      try { (it as? FileOutputStream)?.fd?.sync() } catch (_: Exception) { }
    }
  }

  @Command
  fun pick(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      intent.addFlags(readWrite or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
      startActivityForResult(invoke, intent, "pickResult")
    } catch (e: Exception) {
      invoke.reject(e.message ?: "Cannot open the folder picker")
    }
  }

  @ActivityCallback
  fun pickResult(invoke: Invoke, result: ActivityResult) {
    val tree = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || tree == null) {
      invoke.resolve(JSObject()) // cancelled
      return
    }
    io.execute {
      try {
        activity.contentResolver.takePersistableUriPermission(tree, readWrite)
        val out = JSObject()
        out.put("tree", tree.toString())
        out.put("name", displayName(rootDocument(tree)) ?: tree.lastPathSegment)
        invoke.resolve(out)
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  /** Whether the app can still use [LibraryArgs.tree], and its name. */
  @Command
  fun describe(invoke: Invoke) {
    background(invoke) { args ->
      val tree = treeOf(args)
      val name = if (hasAccess(tree)) {
        try { displayName(rootDocument(tree)) } catch (_: Exception) { null }
      } else null
      val out = JSObject()
      out.put("ok", name != null)
      if (name != null) out.put("name", name)
      out
    }
  }

  /** Gives back the access to every folder except [LibraryArgs.tree]. */
  @Command
  fun keepOnly(invoke: Invoke) {
    background(invoke) { args ->
      val keep = args.tree?.takeIf { it.isNotEmpty() }
      for (permission in activity.contentResolver.persistedUriPermissions) {
        if (permission.uri.toString() != keep) {
          try {
            activity.contentResolver.releasePersistableUriPermission(permission.uri, readWrite)
          } catch (_: Exception) { }
        }
      }
      JSObject()
    }
  }

  @Command
  fun list(invoke: Invoke) {
    background(invoke) { args ->
      val files = JSArray()
      for (child in children(treeOf(args))) {
        if (child.name.startsWith(".")) continue
        val file = JSObject()
        file.put("name", child.name)
        file.put("size", child.size)
        file.put("modified", child.modified)
        files.put(file)
      }
      val out = JSObject()
      out.put("files", files)
      out
    }
  }

  @Command
  fun read(invoke: Invoke) {
    background(invoke) { args ->
      val tree = treeOf(args)
      val name = nameOf(args)
      val bytes = withDocument(tree, name) { doc ->
        activity.contentResolver.openInputStream(doc)?.use { it.readBytes() } ?: throw FileNotFoundException(name)
      }
      val out = JSObject()
      if (args.asBase64) out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      else out.put("text", String(bytes, Charsets.UTF_8))
      out
    }
  }

  @Command
  fun write(invoke: Invoke) {
    background(invoke) { args ->
      val tree = treeOf(args)
      val name = nameOf(args)
      val bytes = args.text?.toByteArray(Charsets.UTF_8)
        ?: args.base64?.let { Base64.decode(it, Base64.DEFAULT) }
        ?: throw IllegalArgumentException("Nothing to write")
      val resolver = activity.contentResolver
      val parent = rootDocument(tree)
      val existing = find(tree, name)
      if (existing == null) {
        val created = DocumentsContract.createDocument(resolver, parent, mimeOf(name), name)
          ?: throw IOException("Cannot create $name")
        writeBytes(created, bytes)
      } else {
        // Write a new document first, then swap it in: a killed app never
        // leaves a half-written card. Falls back to overwriting in place
        // when the folder's provider cannot rename.
        var swapped = false
        val part = try {
          DocumentsContract.createDocument(resolver, parent, mimeOf(name), "$name.part")
        } catch (_: Exception) { null }
        if (part != null) {
          try {
            writeBytes(part, bytes)
            DocumentsContract.deleteDocument(resolver, existing)
            swapped = DocumentsContract.renameDocument(resolver, part, name) != null
          } catch (_: Exception) { }
          if (!swapped) {
            try { DocumentsContract.deleteDocument(resolver, part) } catch (_: Exception) { }
          }
        }
        if (!swapped) {
          children(tree) // the old document may be gone
          val target = find(tree, name)
          if (target != null) {
            writeBytes(target, bytes)
          } else {
            val created = DocumentsContract.createDocument(resolver, parent, mimeOf(name), name)
              ?: throw IOException("Cannot create $name")
            writeBytes(created, bytes)
          }
        }
      }
      children(tree) // the provider may have changed ids
      JSObject()
    }
  }

  @Command
  fun delete(invoke: Invoke) {
    background(invoke) { args ->
      val tree = treeOf(args)
      val name = nameOf(args)
      val doc = find(tree, name)
      if (doc != null) {
        try {
          DocumentsContract.deleteDocument(activity.contentResolver, doc)
        } catch (_: FileNotFoundException) { }
        ids.remove(cacheKey(tree, name))
      }
      JSObject()
    }
  }
}
