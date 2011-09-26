EXTDIR    := ext/
BUILDDIR  := build/
FILES     := $(shell find ${EXTDIR}/ -type f) ${GEN_FILES}

NAME      := $(shell sed -nre 's/.*em:name="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf)
ID        := $(shell sed -nre 's/.*em:id="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf | head -n1)
VERSION   := $(shell sed -nre 's/.*em:version="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf)
MINVER    := $(shell sed -nre 's/.*em:minVersion="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf)
MAXVER    := $(shell sed -nre 's/.*em:maxVersion="(.+?)".*/\1/p;' ${EXTDIR}/install.rdf)

EXTRA     := ${ID}

SHORTNAME := $(shell echo ${ID}   | sed -re 's/@.+//')
FNAME     := $(shell echo ${NAME} | sed -re "s/[/ ]//g")
PXPI      := ${FNAME}_${VERSION}.xpi
XPI       := $(addprefix ${BUILDDIR},${PXPI})

SUBST_CMD := sed -re "s/%ID%/${ID}/g" -e "s/%NAME%/${NAME}/g" -e "s/%FNAME%/${FNAME}/g" -e "s/%SHORTNAME%/${SHORTNAME}/g" \
		-e "s/%XPI%/${PXPI}/g" -e "s/%VERSION%/${VERSION}/g" -e "s/%MINVER%/${MINVER}/g" -e "s/%MAXVER%/${MAXVER}/g"

.PHONY : clean all id
all : ${XPI} $(addprefix ${BUILDDIR}, ${EXTRA})

${XPI}: ${FILES}
	cd ${EXTDIR} && 7z a -tzip -r -mx=9 -x\!\*.bak -x\!\*.in "../$@" *

id: $(addprefix ${BUILDDIR}, ${ID})

$(addprefix ${BUILDDIR}, ${ID}): ${EXTDIR}/install.rdf
	(cygpath -aw ${EXTDIR} || echo `pwd`/${EXTDIR}) > $(addprefix ${BUILDDIR}, ${ID})

clean:
	rm -rf ${BUILDDIR}
