#import "/.inkycap/notebox.typ": *
#set text(lang: "fr", region: "CA")

#note(
  title: "Installer InkyCap",
  description: "Comment télécharger, installer et mettre à jour InkyCap sous Linux, macOS et Windows, y compris le vérificateur de mises à jour intégré et respectueux de la vie privée.",
  tags: ("documentation",),
)

= Installer InkyCap

InkyCap est une application de bureau que vous installez sur votre propre ordinateur. Par défaut, tout ce que vous écrivez reste sur votre machine (à moins que vous ne choisissiez explicitement de le partager à l'extérieur).

== Installer selon votre plateforme

InkyCap vise à fonctionner sous Linux, macOS et Windows. Le fichier que vous téléchargez dépend de votre système.

=== Où télécharger

La page de téléchargement, à #link("https://inkycap.org/download")[inkycap.org/download], offre la version courante pour chaque plateforme. Les versions sont aussi listées sur la page des versions du projet, à #link("https://codefloe.com/InkyCap/app/releases")[codefloe.com/InkyCap/app/releases].

#callout("note")[Le projet est passé de Codeberg à CodeFloe en septembre 2026. L'ancien dépôt Codeberg est archivé et en lecture seule ; il conserve toutes les versions jusqu'à la 26.9.4, mais les versions plus récentes n'apparaissent que sur CodeFloe. ]

=== Linux

Sous Linux, vous aurez le choix entre plusieurs formats de package :

- Un package *.deb*, pour les systèmes basés sur Debian et Ubuntu, installé au moyen de vos outils de package habituels.
- Un package *.rpm*, pour les systèmes basés sur Fedora et openSUSE.
- Un bundle *Flatpak*, qui fonctionne sur la plupart des distributions. Vous installez directement le fichier `.flatpak` téléchargé (il n'est pas sur Flathub) ; il apparaît ensuite dans votre menu d'applications.

Ces trois formats passent par les outils de package de votre système et suivent l'apparence native de votre bureau. InkyCap peut vous indiquer lorsqu'une nouvelle version est disponible, mais vous devez la télécharger et l'installer vous-même.

#callout("note", title: "Pour les utilisatrices et utilisateurs de Typst")[Le package `.deb` installe le serveur de langage embarqué d'InkyCap sous le nom `inkycap-tinymist`, de sorte qu'il n'entre jamais en conflit avec un Tinymist que vous auriez installé séparément. Le Flatpak est bâti sur l'environnement d'exécution GNOME 50. ]

=== macOS

Sous macOS, vous téléchargerez une image disque `.dmg`, l'ouvrirez et glisserez InkyCap dans votre dossier Applications, comme vous le feriez avec la plupart des logiciels Mac. Il existe des builds distincts pour les Mac à puce Apple et les Mac Intel ; choisissez celui qui correspond à votre ordinateur.

#callout("important")[Les builds macOS d'InkyCap ne sont pas signés ni notariés par Apple. La première fois que vous ouvrirez InkyCap, macOS vous avertira qu'il provient d'un « développeur non identifié ». C'est normal. Pour l'ouvrir malgré tout, faites un clic droit (ou un clic avec la touche Contrôle) sur l'application dans votre dossier Applications et choisissez *Ouvrir* ; vous n'avez à le faire qu'une seule fois. Ne faites cela que pour un logiciel auquel vous faites confiance et que vous avez téléchargé depuis inkycap.org.]

=== Windows

Sous Windows, vous avez le choix entre un programme d'installation `-setup.exe`, qui vous guide à travers les étapes à l'écran, et un package `.msi`, qui convient aux organisations qui installent les logiciels de façon centralisée. Dans les deux cas, une fois installé, InkyCap se comporte comme les autres applications Windows. Il ne se met pas à jour lui-même ; voyez ci-dessous comment fonctionnent les mises à jour.

== Ouvrir InkyCap pour la première fois

Après l'installation, lancez InkyCap comme vous lancez n'importe quelle autre application (depuis votre menu d'applications, le Launchpad ou le menu Démarrer). La première chose que vous voudrez faire est de le pointer vers un dossier pour vos notes (votre « boîte de notes »).

Pour une visite guidée de cette première séance (créer une boîte de notes, écrire votre première note et vous repérer), allez directement à #wikilink("4 - Démarrage rapide"). Si vous préférez d'abord comprendre plus en profondeur la notion de boîte de notes, voyez #wikilink("3 - Configurer votre boîte de notes").

== Comment fonctionnent les mises à jour

InkyCap peut vous indiquer lorsqu'une version plus récente est disponible, mais il n'installe rien lui-même. Vous devez télécharger et installer les nouvelles versions vous-même. InkyCap est conçu pour respecter votre vie privée : *InkyCap ne contacte pas le réseau à moins que vous ne le lui demandiez*.

Vous trouverez tout ce qui touche aux mises à jour dans #wikilink("2 - Paramètres"), sous les sections *Vue d'ensemble* et *Comportement*.

=== Vérifier manuellement

1. Ouvrez #wikilink("2 - Paramètres") et allez à la section *Vue d'ensemble*.
2. Trouvez la rubrique *Mises à jour du logiciel* et cliquez sur *Rechercher des mises à jour*.
3. InkyCap se connecte une seule fois pour voir s'il existe une version plus récente, puis vous le rapporte.

Si vous êtes à jour, vous verrez « Vous utilisez la dernière version. »

=== Quand une nouvelle version est disponible

S'il existe quelque chose de plus récent, InkyCap indique « La version X est disponible au téléchargement. » et propose trois boutons :

- *Télécharger* ouvre la page de téléchargement d'inkycap.org dans votre navigateur.
- *Voir les versions* ouvre la page des versions sur CodeFloe, où vous pouvez lire ce qui a changé.
- *Vérifier de nouveau* répète la vérification.

#callout("note")[
  La vérification lit un fichier sur inkycap.org qui indique le numéro de la dernière version. Elle n'envoie aucune information sur vous, votre ordinateur ou votre boîte de notes.
]

=== Vérifier automatiquement au démarrage

Si vous voulez qu'InkyCap cherche les mises à jour de lui-même, vous pouvez l'activer :

1. Ouvrez #wikilink("2 - Paramètres") et allez à la section *Comportement*.
2. Sous *Mises à jour du logiciel*, activez *Rechercher des mises à jour au démarrage*.

Cette option est *désactivée par défaut*. Activée, InkyCap vérifie une fois peu après le lancement et affiche un petit message si quelque chose de plus récent est disponible. Il y a aussi une option *Inclure les versions de développement (bêta)* (également désactivée par défaut) si vous voulez être informé des versions préliminaires.

== Savoir quelle version vous utilisez

Pour voir votre version actuelle, ouvrez #wikilink("2 - Paramètres") et regardez la section *Vue d'ensemble*, où le numéro de version est affiché. Les numéros de version d'InkyCap ont trois parties, `année.mois.version` (par exemple, 26.9.10 est la dixième version de septembre 2026). Le dernier nombre vous indique quel type de build vous avez : les nombres pairs sont des versions stables et les nombres impairs sont des builds de développement. Si vous utilisez une version de développement, vous verrez aussi un petit badge *Version de développement* à côté du numéro, de sorte que vous savez toujours si vous êtes sur une copie stable ou préliminaire.

== Obtenir de l'aide

La section *Vue d'ensemble* de #wikilink("2 - Paramètres") inclut aussi une rubrique *Aide* avec un lien vers la documentation d'InkyCap. C'est un bon endroit où revenir chaque fois que vous voulez en apprendre davantage sur une fonctionnalité.

Vous pouvez atteindre le même manuel de n'importe où dans l'application : appuyez sur *F1* (ou cliquez sur le bouton *Aide* de la barre d'outils verticale) pour ouvrir le panneau d'aide, qui offre en haut un bouton *Documentation InkyCap* et un bouton *Documentation Typst*. Le panneau lui-même liste tous les raccourcis clavier et un aide-mémoire du balisage Typst ; voyez #wikilink("1 - L'interface InkyCap") pour en faire le tour.

== Pages connexes

- #wikilink("4 - Démarrage rapide")
- #wikilink("3 - Configurer votre boîte de notes")
- #wikilink("2 - Paramètres")
- #wikilink("1 - Prise en main")
- #wikilink("1 - L'interface InkyCap")
