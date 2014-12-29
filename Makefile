EXTDIR    := ext/
BUILDDIR  := build/

NAME      := $(shell sed -nre 's/.*em:name="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf | head -n1)
ID        := $(shell sed -nre 's/.*em:id="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf | head -n1)
VERSION   := $(shell sed -nre 's/.*em:version="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf | head -n1)

FILES     := $(shell find ${EXTDIR}/ -type f)
FNAME     := $(shell echo ${NAME} | sed -re "s/[/ :]//g")
XPI       := $(addprefix ${BUILDDIR},${FNAME}_${VERSION}.xpi)
IDFILE    := $(addprefix ${BUILDDIR},${ID})

.PHONY : clean all id

all: ${XPI} ${IDFILE}
id: ${IDFILE}

${XPI}: ${FILES}
	mkdir -p ${BUILDDIR}
	rm -f "$@"
	cd ${EXTDIR} && zip -1 -r -x\*.bak "../$@" *

${IDFILE}: ${EXTDIR}/install.rdf
	(cygpath -aw ${EXTDIR} || echo `pwd`/${EXTDIR}) > $(addprefix ${BUILDDIR}, ${ID})

clean:
	rm -rf ${BUILDDIR}
