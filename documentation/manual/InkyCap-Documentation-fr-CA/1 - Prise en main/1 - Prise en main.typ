#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Prise en main",
  description: "Survol de la section : la prise en main d'InkyCap.",
  tags: ("documentation",),
  aliases: ("Prise en main",),
)

= Prise en main

Commencez ici si InkyCap est nouveau pour vous : cette section vous expliquera tout ce qu'il vous faut pour passer d'une installation toute neuve à une boîte de notes fonctionnelle et connectée.

InkyCap est une application de gestion des connaissances personnelles basée sur le balisage #link("https://typst.app")[Typst] : vous écrivez dans des fichiers texte simples et portables, vous les reliez entre eux et vous les transformez en PDF ou en pages web soignés.

== Dans cette section

- #wikilink("2 - Installer InkyCap") montre comment télécharger, installer et mettre à jour InkyCap sous Linux, MacOS et Windows, y compris le vérificateur de mises à jour intégré.
- #wikilink("3 - Configurer votre boîte de notes") explique comment fonctionne une boîte de notes (un dossier portable de vos notes .typ accompagné d'une configuration .inkycap cachée), les trois façons d'en démarrer une, et comment organiser, ouvrir et changer de boîte de notes.
- #wikilink("4 - Démarrage rapide") vous donne le chemin le plus rapide entre l'installation d'InkyCap et la création d'une boîte de notes, la rédaction de votre première note et la mise en relation de notes par des liens wiki.

#callout("tip", title: "Pour les développeuses, développeurs ou les utilisatrices et utilisateurs avancés")[
  InkyCap est bâti avec Tauri (un arrière-plan Rust avec une interface en technologies web) et embarque le serveur de langage Tinymist, ce qui vous donne l'autocomplétion du code Typst d'emblée. Aucune installation séparée de Typst ou de Tinymist n'est requise. Le code source et les archives de versions sont hébergés sur Codeberg, à `codeberg.org/InkyCap/app`.
]
