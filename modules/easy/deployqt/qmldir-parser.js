// SPDX-FileCopyrightText: © 2024 Serhii “GooRoo” Olendarenko
//
// SPDX-License-Identifier: BSD-3-Clause

const FileInfo = require('qbs.FileInfo')
const TextFile = require('qbs.TextFile')

var QmldirParser = (function () {
	function Parser(qmldirFilePath, os, debug) {
		var qmldir = new TextFile(qmldirFilePath, TextFile.ReadOnly)
		this.lines = qmldir.readAll().split('\n')
		qmldir.close()

		this.os = os
		this.debug = debug

		this.module = ''
		this.plugins = new Set()
		this.depends = new Set()
		this.imports = new Set()
		this.optionalImports = new Set()
		this.files = new Set()
	}

	Parser.prototype.constructor = Parser

	Parser.prototype.parseLine = function (line) {
		if (line.trim() === ''
			|| line.startsWith('#')
			|| line.startsWith('linktarget')
			|| line.startsWith('prefer')
			|| line.startsWith('classname')
			|| line.startsWith('designersupported')
			|| line.startsWith('system')) {
			// skip things I don't need now
			return
		} else if (line.startsWith('module')) {
			this.parseModule(line)
		} else if (line.startsWith('plugin') || /^optional\s+plugin/.test(line)) {
			this.parsePlugin(line)
		} else if (line.startsWith('depends')) {
			this.parseDepends(line)
		} else if (line.startsWith('import') || /^(optional|default)\s+import/.test(line)) {
			this.parseImport(line)
		} else if (line.startsWith('typeinfo')) {
			this.parseTypeInfo(line)
		} else if (line.startsWith('internal')) {
			this.parseInternal(line)
		} else {
			this.parseObjectDeclaration(line)
		}
	}

	Parser.prototype.parseModule = function (moduleString) {
		const modulePattern = /^module\s+(?<name>[\w\.]+)?$/
		const match = moduleString.match(modulePattern)
		if (match) {
			this.module = match.groups.name
		} else {
			throw new Error('Cannot parse the module string: ' + moduleString)
		}
	}

	Parser.prototype.parseObjectDeclaration = function (objectDeclarationString) {
		const pattern = /^(?:singleton\s+)?(?<name>\w+)\s+(?<version>\d+\.\d+)\s+(?<path>.+)$/
		const match = objectDeclarationString.match(pattern)
		if (match) {
			this.files.add(match.groups.path)
		} else {
			throw new Error('Cannot parse the object declaration string: ' + objectDeclarationString)
		}
	}

	Parser.prototype.parseInternal = function (internalString) {
		const internalPattern = /^internal\s+(?<name>\w+)\s+(?<path>.+)$/
		const match = internalString.match(internalPattern)
		if (match) {
			this.files.add(match.groups.path)
		} else {
			throw new Error('Cannot parse the internal string: ' + internalString)
		}
	}

	Parser.prototype.parseTypeInfo = function (typeInfoString) {
		const typeInfoPattern = /^typeinfo\s+(?<path>.+)$/
		const match = typeInfoString.match(typeInfoPattern)
		if (match) {
			this.files.add(match.groups.path)
		} else {
			throw new Error('Cannot parse the typeinfo string: ' + typeInfoString)
		}
	}

	Parser.prototype.parsePlugin = function (pluginString) {
		const pluginPattern = /^(optional\s+)?plugin\s+(?<name>\w+)(?:\s+(?<path>[\w/]+))?$/
		const match = pluginString.match(pluginPattern)
		if (match) {
			var name = this.pluginNameToFileName(match.groups.name)
			if (match.groups.path) {
				name = FileInfo.joinPaths(match.groups.path, name)
			}
			this.plugins.add(name)
		} else {
			throw new Error('Cannot parse the plugin string: ' + pluginString)
		}
	}

	Parser.prototype.pluginNameToFileName = function (libName) {
		if (this.os.contains('windows')) {
			return this.debug? libName + 'd.dll' : libName + '.dll'
		} else if (this.os.contains('macos')) {
			return 'lib' + libName + '.dylib'
		}
	}

	Parser.prototype.parseDepends = function (dependsString) {
		const dependsPattern = /^depends\s+(?<name>[\w\.]+)(?:\s+(?<version>(?:auto|\d+(?:\.\d+)*)))?$/
		const match = dependsString.match(dependsPattern)
		if (match) {
			this.depends.add(match.groups.name)
		} else {
			throw new Error('Cannot parse the depends string: ' + dependsString)
		}
	}

	Parser.prototype.parseImport = function (importString) {
		const importPattern = /^(?:default\s+)?(?<optional>optional\s+)?import\s+(?<name>[\w\.]+)(?:\s+(?<version>(?:auto|\d+(?:\.\d+)*)))$/
		const match = importString.match(importPattern)
		if (match) {
			if (match.groups.optional) {
				this.optionalImports.add(match.groups.name)
			} else {
				this.imports.add(match.groups.name)
			}
		} else {
			throw new Error('Cannot parse the import string: ' + importString)
		}
	}

	Parser.prototype.parse = function () {
		for (var i in this.lines) {
			this.parseLine(this.lines[i])
		}
		return {
			plugins: this.plugins,
			depends: this.depends,
			imports: this.imports,
			optionalImports: this.optionalImports,
			files: this.files,
		}
	}

	return Parser
})()
